/**
 * Парсер NDJSON-стрима Ollama (/api/chat) (plan-24, Task 3).
 */

import { ProviderRuntimeError } from "../provider-error-mapper.js";
import type {
  ProviderStreamChunk,
  ProviderStreamParser,
  ProviderUsage,
} from "../provider-runtime-port.js";
import { parseOllamaCompletionBody } from "../provider-response.js";

/** Создаёт парсер NDJSON-стрима Ollama. */
export function createOllamaNDJSParser(): ProviderStreamParser {
  let buffer = "";
  let sawDone = false;
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
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "ollama-ndjson");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "ollama-ndjson-shape");
    }
    const root = parsed as Record<string, unknown>;
    if (root.done === true) {
      sawDone = true;
      if (typeof root.done_reason === "string") {
        finishReason = root.done_reason === "stop"
          ? "stop"
          : root.done_reason === "length"
            ? "length"
            : root.done_reason === "unload"
              ? "stop"
              : "other";
      }
      chunks.push({ kind: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") });
    }
    const message = root.message;
    if (message !== null && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as Record<string, unknown>;
      if (typeof messageRecord.content === "string" && (messageRecord.content as string).length > 0) {
        chunks.push({ kind: "content", text: messageRecord.content as string });
      }
      const rawCalls = messageRecord.tool_calls;
      if (Array.isArray(rawCalls)) {
        for (const raw of rawCalls) {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
          const rawRecord = raw as Record<string, unknown>;
          const fn = rawRecord.function;
          if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
          const functionRecord = fn as Record<string, unknown>;
          const index = toolState.size;
          const name = typeof functionRecord.name === "string" ? functionRecord.name : "";
          sawToolCall = true;
          const args = functionRecord.arguments !== undefined ? JSON.stringify(functionRecord.arguments) : "{}";
          toolState.set(index, { id: `ollama_call_${index}`, name, args });
          chunks.push({ kind: "tool-call-start", index, id: `ollama_call_${index}`, name });
          chunks.push({ kind: "tool-call-arguments", index, argumentsDelta: args });
          flushToolEnd(chunks, index);
        }
      }
    }
    if (root.prompt_eval_count !== undefined || root.eval_count !== undefined) {
      const usage: ProviderUsage = {
        inputTokens: nonNegativeInt(root.prompt_eval_count),
        cachedInputTokens: 0,
        outputTokens: nonNegativeInt(root.eval_count),
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
      if (!sawDone) {
        throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "ollama-unfinished");
      }
      if (!chunks.some((chunk) => chunk.kind === "finish")) {
        chunks.push({ kind: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") });
      }
    },
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Экспорт для консистентности с provider-response (переиспользуется парсер JSON).
 */
export { parseOllamaCompletionBody };
