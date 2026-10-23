/**
 * Канонический парсер ответов/стримов провайдеров (plan-24, Task 3).
 *
 * Поддерживаются:
 *  - JSON-ответы (OpenAI-совместимые, Anthropic, Ollama, Google Generative);
 *  - SSE-стримы (как OpenAI `data:`-события, так и Anthropic `event:`-события);
 *  - tool_calls (OpenAI `tool_calls`, Anthropic `tool_use`, Ollama
 *    `tool_calls`, Google `functionCall`);
 *  - извлечение usage (input/cached/output токены; cost всегда null, если
 *    источник не сообщил стоимость);
 *  - хук валидации структурированного результата по ролевому контракту.
 *
 * Ошибки парсинга бросаются как `ProviderRuntimeError` с классификацией
 * (без текста ошибки провайдера наружу).
 */

import { validateRoleOutput } from "../output-validator.js";
import { ProviderRuntimeError } from "./provider-error-mapper.js";
import type {
  ProviderChatResponse,
  ProviderFinishReason,
  ProviderStreamChunk,
  ProviderStreamParser,
  ProviderToolCall,
  ProviderUsage,
} from "./provider-runtime-port.js";
import { EMPTY_PROVIDER_USAGE } from "./provider-runtime-port.js";

/** Нормализует usage из OpenAI-совместимого объекта. */
export function extractOpenAIUsage(usage: unknown): ProviderUsage {
  if (usage === null || typeof usage !== "object") return EMPTY_PROVIDER_USAGE;
  const record = usage as Record<string, unknown>;
  const promptTokens = nonNegativeInt(record.prompt_tokens);
  const completionTokens = nonNegativeInt(record.completion_tokens);
  const details = record.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = details && typeof details.cached_tokens === "number"
    ? nonNegativeInt(details.cached_tokens)
    : 0;
  return {
    inputTokens: promptTokens,
    cachedInputTokens: cachedTokens,
    outputTokens: completionTokens,
    cost: null,
  };
}

/** Нормализует usage из Anthropic-ответа. */
export function extractAnthropicUsage(usage: unknown): ProviderUsage {
  if (usage === null || typeof usage !== "object") return EMPTY_PROVIDER_USAGE;
  const record = usage as Record<string, unknown>;
  const inputTokens = nonNegativeInt(record.input_tokens);
  const outputTokens = nonNegativeInt(record.output_tokens);
  const cacheRead = nonNegativeInt(record.cache_read_input_tokens);
  const cacheCreation = nonNegativeInt(record.cache_creation_input_tokens);
  return {
    inputTokens,
    cachedInputTokens: cacheRead + cacheCreation,
    outputTokens,
    cost: null,
  };
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, _what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderRuntimeError("PROVIDER_RESPONSE_PARSE_ERROR", _what);
  return value;
}

function stringField(record: Record<string, unknown>, key: string, _what: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function normalizeFinishReason(value: unknown): ProviderFinishReason {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "other";
  switch (value) {
    case "stop":
    case "end_turn":
    case "done":
      return "stop";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
    case "safety":
      return "content_filter";
    default:
      return "other";
  }
}

function parseToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") return argumentsValue;
  if (argumentsValue !== undefined && argumentsValue !== null) {
    try {
      return JSON.stringify(argumentsValue);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

/** Разбирает OpenAI-совместимый JSON-ответ. */
export function parseOpenAICompletionBody(body: unknown): ProviderChatResponse {
  const root = requireRecord(body, "openai-root");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderRuntimeError("PROVIDER_RESPONSE_PARSE_ERROR", "no-choices");
  }
  const choice = requireRecord(choices[0], "openai-choice");
  const message = choice.message === undefined ? {} : requireRecord(choice.message, "openai-message");
  const contentValue = message.content;
  let content = "";
  if (typeof contentValue === "string") content = contentValue;
  else if (Array.isArray(contentValue)) {
    content = contentValue
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  const toolCalls: ProviderToolCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      if (!isRecord(raw)) continue;
      const fn = raw.function === undefined ? {} : requireRecord(raw.function, "openai-tool-function");
      const id = typeof raw.id === "string" ? raw.id : `call_${toolCalls.length}`;
      const name = typeof fn.name === "string" ? fn.name : "";
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: parseToolArguments(fn.arguments) },
      });
    }
  }
  const finishReason = normalizeFinishReason(choice.finish_reason);
  const usage = extractOpenAIUsage(root.usage);
  return {
    id: stringField(root, "id", "openai-id"),
    model: stringField(root, "model", "openai-model"),
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 && finishReason === null ? "tool_calls" : finishReason,
    usage,
  };
}

/** Разбирает Anthropic JSON-ответ (messages API). */
export function parseAnthropicCompletionBody(body: unknown): ProviderChatResponse {
  const root = requireRecord(body, "anthropic-root");
  const contentArray = root.content;
  if (!Array.isArray(contentArray)) {
    throw new ProviderRuntimeError("PROVIDER_RESPONSE_PARSE_ERROR", "anthropic-content");
  }
  let content = "";
  const toolCalls: ProviderToolCall[] = [];
  for (const block of contentArray) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") content += block.text;
    else if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : `toolu_${toolCalls.length}`;
      const name = typeof block.name === "string" ? block.name : "";
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: parseToolArguments(block.input) },
      });
    }
  }
  const finishReason = normalizeFinishReason(root.stop_reason);
  const usage = extractAnthropicUsage(root.usage);
  return {
    id: stringField(root, "id", "anthropic-id"),
    model: stringField(root, "model", "anthropic-model"),
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 && finishReason === null ? "tool_calls" : finishReason,
    usage,
  };
}

/** Разбирает Ollama-native JSON-ответ (/api/chat). */
export function parseOllamaCompletionBody(body: unknown): ProviderChatResponse {
  const root = requireRecord(body, "ollama-root");
  const message = root.message === undefined ? {} : requireRecord(root.message, "ollama-message");
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls: ProviderToolCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      if (!isRecord(raw)) continue;
      const fn = raw.function === undefined ? {} : requireRecord(raw.function, "ollama-tool-function");
      const name = typeof fn.name === "string" ? fn.name : "";
      toolCalls.push({
        id: `ollama_call_${toolCalls.length}`,
        type: "function",
        function: { name, arguments: parseToolArguments(fn.arguments) },
      });
    }
  }
  const finishReason = root.done === true
    ? (normalizeFinishReason(root.done_reason) ?? (toolCalls.length > 0 ? "tool_calls" : "stop"))
    : null;
  const effectiveFinishReason: ProviderFinishReason =
    finishReason === "stop" && toolCalls.length > 0 ? "tool_calls" : finishReason;
  const usage: ProviderUsage = {
    inputTokens: nonNegativeInt(root.prompt_eval_count),
    cachedInputTokens: 0,
    outputTokens: nonNegativeInt(root.eval_count),
    cost: null,
  };
  return {
    id: null,
    model: stringField(root, "model", "ollama-model"),
    content,
    toolCalls,
    finishReason: effectiveFinishReason,
    usage,
  };
}

/** Разбирает Google Generative Language JSON-ответ. */
export function parseGoogleGenerativeCompletionBody(body: unknown): ProviderChatResponse {
  const root = requireRecord(body, "google-root");
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ProviderRuntimeError("PROVIDER_RESPONSE_PARSE_ERROR", "google-no-candidates");
  }
  const candidate = requireRecord(candidates[0], "google-candidate");
  const contentObj = candidate.content === undefined ? {} : requireRecord(candidate.content, "google-content");
  const parts = contentObj.parts;
  let content = "";
  const toolCalls: ProviderToolCall[] = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") content += part.text;
      else if (isRecord(part.functionCall)) {
        const call = part.functionCall;
        const name = typeof call.name === "string" ? call.name : "";
        const args = call.args !== undefined ? call.args : {};
        toolCalls.push({
          id: `google_call_${toolCalls.length}`,
          type: "function",
          function: { name, arguments: parseToolArguments(args) },
        });
      }
    }
  }
  const finishReason = normalizeFinishReason(candidate.finishReason);
  const usageMeta = root.usageMetadata;
  const usage: ProviderUsage = usageMeta && isRecord(usageMeta)
    ? {
        inputTokens: nonNegativeInt(usageMeta.promptTokenCount),
        cachedInputTokens: nonNegativeInt(usageMeta.cachedContentTokenCount),
        outputTokens: nonNegativeInt(usageMeta.candidatesTokenCount),
        cost: null,
      }
    : EMPTY_PROVIDER_USAGE;
  return {
    id: null,
    model: stringField(root, "modelVersion", "google-model"),
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 && finishReason === null ? "tool_calls" : finishReason,
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* SSE-ядро                                                           */
/* ------------------------------------------------------------------ */

interface RawSSEEvent {
  readonly event: string | null;
  readonly data: string;
}

/** Разделяет побайтовый поток на строки и накапливает SSE-события. */
class SSELineBuffer {
  private buffer = "";
  private events: RawSSEEvent[] = [];
  private currentEvent: string | null = null;
  private dataLines: string[] = [];

  public push(chunk: Uint8Array): readonly RawSSEEvent[] {
    this.buffer += Buffer.from(chunk).toString("utf8");
    const out: RawSSEEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, out);
    }
    return out;
  }

  public finish(): readonly RawSSEEvent[] {
    const out: RawSSEEvent[] = [];
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer, out);
      this.buffer = "";
    }
    return out;
  }

  private consumeLine(line: string, out: RawSSEEvent[]): void {
    if (line === "") {
      if (this.dataLines.length > 0) {
        out.push({ event: this.currentEvent, data: this.dataLines.join("\n") });
      }
      this.currentEvent = null;
      this.dataLines = [];
      return;
    }
    if (line.startsWith(":")) return; // комментарий
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") this.currentEvent = value;
    else if (field === "data") this.dataLines.push(value);
    // поле id/retry игнорируется
  }
}

function parseSSEEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "sse-data-json");
  }
}

/** Создаёт парсер OpenAI-совместимого SSE-стрима. */
export function createOpenAISSEParser(): ProviderStreamParser {
  const lines = new SSELineBuffer();
  let finished = false;
  let finishReason: ProviderFinishReason = null;
  let sawToolCall = false;
  const toolState = new Map<number, { id: string; name: string; args: string }>();

  const flushToolEnd = (chunks: ProviderStreamChunk[], index: number): void => {
    if (toolState.has(index)) {
      chunks.push({ kind: "tool-call-end", index });
      toolState.delete(index);
    }
  };

  return {
    push(chunk) {
      const chunks: ProviderStreamChunk[] = [];
      const events = lines.push(chunk);
      for (const event of events) {
        if (event.data === "[DONE]") {
          finished = true;
          chunks.push({ kind: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") });
          continue;
        }
        const parsed = parseSSEEventData(event.data);
        const root = requireRecord(parsed, "openai-sse");
        const choices = root.choices;
        if (Array.isArray(choices) && choices.length > 0) {
          const choice = requireRecord(choices[0], "openai-sse-choice");
          const delta = choice.delta === undefined ? {} : requireRecord(choice.delta, "openai-sse-delta");
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunks.push({ kind: "content", text: delta.content });
          }
          const rawCalls = delta.tool_calls;
          if (Array.isArray(rawCalls)) {
            for (const raw of rawCalls) {
              if (!isRecord(raw)) continue;
              const index = typeof raw.index === "number" ? raw.index : 0;
              sawToolCall = true;
              const state = toolState.get(index) ?? { id: "", name: "", args: "" };
              if (typeof raw.id === "string" && raw.id.length > 0) state.id = raw.id;
              if (isRecord(raw.function)) {
                if (typeof raw.function.name === "string" && raw.function.name.length > 0) {
                  state.name = raw.function.name;
                  chunks.push({ kind: "tool-call-start", index, id: state.id, name: state.name });
                }
                if (typeof raw.function.arguments === "string" && raw.function.arguments.length > 0) {
                  state.args += raw.function.arguments;
                  chunks.push({ kind: "tool-call-arguments", index, argumentsDelta: raw.function.arguments });
                }
              }
              if (state.id === "") state.id = `call_${index}`;
              toolState.set(index, state);
            }
          }
          const fr = normalizeFinishReason(choice.finish_reason);
          if (fr !== null) {
            finishReason = fr;
            for (const index of [...toolState.keys()]) flushToolEnd(chunks, index);
            chunks.push({ kind: "finish", finishReason });
          }
        }
        if (root.usage !== undefined) {
          chunks.push({ kind: "usage", usage: extractOpenAIUsage(root.usage) });
        }
      }
      return chunks;
    },
    finish() {
      const chunks: ProviderStreamChunk[] = [];
      const trailing = lines.finish();
      for (const event of trailing) {
        if (event.data === "[DONE]") {
          finished = true;
          chunks.push({ kind: "finish", finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop") });
        }
      }
      for (const index of [...toolState.keys()]) flushToolEnd(chunks, index);
      if (!finished) {
        throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "sse-unfinished");
      }
      if (!chunks.some((chunk) => chunk.kind === "finish")) {
        const finishChunk: ProviderStreamChunk = {
          kind: "finish",
          finishReason: finishReason ?? (sawToolCall ? "tool_calls" : "stop"),
        };
        chunks.push(finishChunk);
      }
    },
  };
}

/** Создаёт парсер Anthropic SSE-стрима (messages API). */
export function createAnthropicSSEParser(): ProviderStreamParser {
  const lines = new SSELineBuffer();
  const toolState = new Map<number, { id: string; name: string; args: string }>();
  let finished = false;
  let finishReason: ProviderFinishReason = null;
  let sawToolCall = false;
  let sawUsage = false;

  return {
    push(chunk) {
      const chunks: ProviderStreamChunk[] = [];
      const events = lines.push(chunk);
      for (const event of events) {
        const parsed = parseSSEEventData(event.data);
        const root = requireRecord(parsed, "anthropic-sse");
        const type = root.type;
        if (typeof type !== "string") continue;
        if (type === "content_block_start") {
          const contentBlock = requireRecord(root.content_block ?? {}, "anthropic-block-start");
          if (contentBlock.type === "tool_use") {
            sawToolCall = true;
            const index = nonNegativeInt(root.index);
            const id = typeof contentBlock.id === "string" ? contentBlock.id : `toolu_${index}`;
            const name = typeof contentBlock.name === "string" ? contentBlock.name : "";
            toolState.set(index, { id, name, args: "" });
            chunks.push({ kind: "tool-call-start", index, id, name });
          }
        } else if (type === "content_block_delta") {
          const delta = requireRecord(root.delta ?? {}, "anthropic-block-delta");
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            chunks.push({ kind: "content", text: delta.text });
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const index = nonNegativeInt(root.index);
            const state = toolState.get(index) ?? { id: `toolu_${index}`, name: "", args: "" };
            state.args += delta.partial_json;
            toolState.set(index, state);
            chunks.push({ kind: "tool-call-arguments", index, argumentsDelta: delta.partial_json });
          }
        } else if (type === "content_block_stop") {
          const index = nonNegativeInt(root.index);
          if (toolState.has(index)) {
            chunks.push({ kind: "tool-call-end", index });
            toolState.delete(index);
          }
        } else if (type === "message_delta") {
          const delta = requireRecord(root.delta ?? {}, "anthropic-message-delta");
          if (typeof delta.stop_reason === "string") {
            finishReason = normalizeFinishReason(delta.stop_reason);
            chunks.push({ kind: "finish", finishReason });
          }
        } else if (type === "message_start" || type === "message_stop") {
          if (type === "message_stop") finished = true;
        } else if (type === "error") {
          // Anthropic stream error event: классифицируем, текст не сохраняем
          chunks.push({
            kind: "error",
            classification: {
              id: "E7030",
              code: "PROVIDER_API_ERROR",
              category: "provider",
              severity: "error",
              attribution: "provider",
              retryable: false,
            },
          });
        }
        if (root.usage !== undefined && isRecord(root.usage)) {
          sawUsage = true;
          chunks.push({ kind: "usage", usage: extractAnthropicUsage(root.usage) });
        }
      }
      return chunks;
    },
    finish() {
      const trailing = lines.finish();
      for (const event of trailing) {
        const parsed = parseSSEEventData(event.data);
        const root = requireRecord(parsed, "anthropic-sse-finish");
        if (root.type === "message_stop") finished = true;
      }
      for (const index of [...toolState.keys()]) {
        // незавершённый tool-блок = ошибка протокола
        void index;
      }
      if (toolState.size > 0) {
        throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "anthropic-unfinished-tool");
      }
      if (!finished && !sawUsage) {
        throw new ProviderRuntimeError("STREAM_PROTOCOL_ERROR", "anthropic-unfinished");
      }
      if (finishReason === null) finishReason = sawToolCall ? "tool_calls" : "stop";
    },
  };
}

/** Хук валидации структурированного результата по ролевому контракту. */
export function createStructuredResultValidator(role: string): (payload: unknown) => {
  valid: boolean;
  output?: unknown;
  error?: string;
} {
  return (payload: unknown) => validateRoleOutput(role, payload);
}
