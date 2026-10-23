/**
 * Парсер SSE-стрима Google Generative Language (plan-24, Task 3).
 */

import { ProviderRuntimeError } from "../provider-error-mapper.js";
import type {
  ProviderStreamChunk,
  ProviderStreamParser,
  ProviderUsage,
} from "../provider-runtime-port.js";
import { parseGoogleGenerativeCompletionBody } from "../provider-response.js";

/** Создаёт парсер SSE-стрима Google (`data: {json}`). */
export function createGoogleGenerativeSSEParser(): ProviderStreamParser {
  let buffer = "";
  let finished = false;
  let sawCandidate = false;
  let sawFinish = false;
  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "other" | null = null;
  let sawToolCall = false;
  const toolState = new Map<number, { id: string; name: string; args: string }>();

  const flushToolEnd = (chunks: ProviderStreamChunk[], index: number): void => {
    if (toolState.has(index)) {
      chunks.push({ kind: "tool-call-end", index });
      toolState.delete(index);
    }
  };

  const handleLine = (line: string, chunks: ProviderStreamChunk[]): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "google-sse-json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "google-sse-shape");
    }
    const root = parsed as Record<string, unknown>;
    const candidates = root.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      sawCandidate = true;
      const candidate = candidates[0] as Record<string, unknown>;
      const contentObj = candidate.content;
      if (contentObj !== null && typeof contentObj === "object" && !Array.isArray(contentObj)) {
        const parts = (contentObj as Record<string, unknown>).parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
            const partRecord = part as Record<string, unknown>;
            if (typeof partRecord.text === "string" && (partRecord.text as string).length > 0) {
              chunks.push({ kind: "content", text: partRecord.text as string });
            }
            const functionCall = partRecord.functionCall;
            if (functionCall !== null && typeof functionCall === "object" && !Array.isArray(functionCall)) {
              const call = functionCall as Record<string, unknown>;
              const index = toolState.size;
              const name = typeof call.name === "string" ? call.name : "";
              const args = call.args !== undefined ? JSON.stringify(call.args) : "{}";
              sawToolCall = true;
              toolState.set(index, { id: `google_call_${index}`, name, args });
              chunks.push({ kind: "tool-call-start", index, id: `google_call_${index}`, name });
              chunks.push({ kind: "tool-call-arguments", index, argumentsDelta: args });
              flushToolEnd(chunks, index);
            }
          }
        }
      }
      if (typeof candidate.finishReason === "string") {
        sawFinish = true;
        const raw = candidate.finishReason as string;
        finishReason = raw === "STOP" ? "stop" : raw === "MAX_TOKENS" ? "length" : raw === "SAFETY" ? "content_filter" : "other";
        chunks.push({ kind: "finish", finishReason });
      }
    }
    const usageMeta = root.usageMetadata;
    if (usageMeta !== null && typeof usageMeta === "object" && !Array.isArray(usageMeta)) {
      const meta = usageMeta as Record<string, unknown>;
      const usage: ProviderUsage = {
        inputTokens: nonNegativeInt(meta.promptTokenCount),
        cachedInputTokens: nonNegativeInt(meta.cachedContentTokenCount),
        outputTokens: nonNegativeInt(meta.candidatesTokenCount),
        cost: null,
      };
      chunks.push({ kind: "usage", usage });
    }
  };

  return {
    push(chunk) {
      buffer += Buffer.from(chunk).toString("utf8");
      const chunks: ProviderStreamChunk[] = [];
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        handleLine(line, chunks);
      }
      return chunks;
    },
    finish() {
      const chunks: ProviderStreamChunk[] = [];
      if (buffer.trim() !== "") {
        handleLine(buffer, chunks);
        buffer = "";
      }
      for (const index of [...toolState.keys()]) flushToolEnd(chunks, index);
      if (!sawCandidate) {
        throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "google-no-candidates");
      }
      if (!sawFinish) {
        if (finished) {
          // поток завершён без явного finishReason — допустимо
        } else {
          finished = true;
        }
        chunks.push({ kind: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") });
      }
    },
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Экспорт для консистентности с provider-response. */
export { parseGoogleGenerativeCompletionBody };
