/**
 * Базовый адаптер OpenAI-совместимых провайдеров (plan-24, Task 3).
 *
 * Покрывает большинство API-key провайдеров каталога (openai-compatible /
 * openai-router / gateway), включая поддержку tool_calls и streaming.
 * Строит канонический запрос и парсит JSON/SSE-ответы через
 * `provider-request.ts` / `provider-response.ts`.
 */

import type {
  ProviderAuthScheme,
  ProviderChatAdapter,
  ProviderChatRequestInput,
  ProviderPreparedRequest,
  ProviderProtocolFamily,
  ProviderStreamParser,
  ProviderToolDefinition,
} from "../provider-runtime-port.js";
import {
  serializeProviderJsonBody,
  toOpenAIMessage,
  toOpenAITool,
} from "../provider-request.js";
import {
  createOpenAISSEParser,
  parseOpenAICompletionBody,
} from "../provider-response.js";

export interface OpenAICompatibleAdapterOptions {
  readonly providerId: string;
  readonly family: ProviderProtocolFamily;
  readonly auth: ProviderAuthScheme;
  /** Путь чат-эндпоинта относительно базового URL. */
  readonly chatPath?: string;
  readonly supportsStreaming?: boolean;
  readonly supportsToolCalls?: boolean;
  /** Провайдер-специфичная правка тела запроса. */
  readonly handleBody?: (input: ProviderChatRequestInput, body: Record<string, unknown>) => Record<string, unknown>;
  /** Провайдер-специфичная правка заголовков. */
  readonly handleHeaders?: () => Readonly<Record<string, string>>;
}

/** Создаёт адаптер OpenAI-совместимого провайдера. */
export function createOpenAICompatibleAdapter(options: OpenAICompatibleAdapterOptions): ProviderChatAdapter {
  const chatPath = options.chatPath ?? "/chat/completions";

  return {
    providerId: options.providerId,
    protocolFamily: options.family,
    auth: options.auth,

    buildRequest(input) {
      let body: Record<string, unknown> = {
        model: input.model,
        messages: input.messages.map(toOpenAIMessage),
        stream: input.stream,
      };
      if (input.tools && input.tools.length > 0 && options.supportsToolCalls !== false) {
        body.tools = input.tools.map(toOpenAITool);
        body.tool_choice = "auto";
      }
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
      if (input.stop && input.stop.length > 0) body.stop = input.stop;
      if (input.extraBody) {
        body = { ...body, ...Object.fromEntries(Object.entries(input.extraBody).filter(([key]) => key !== "model" && key !== "messages" && key !== "stream")) };
      }
      if (options.handleBody) body = options.handleBody(input, body);

      const json = serializeProviderJsonBody(body);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...options.handleHeaders?.(),
      };
      const baseUrl = input.endpoint.replace(/\/+$/u, "");
      const path = chatPath.startsWith("/") ? chatPath : `/${chatPath}`;
      const query = buildEndpointQuery(input.endpointQuery);
      const url = `${baseUrl}${path}${query}`;
      const prepared: ProviderPreparedRequest = {
        method: "POST",
        url,
        headers,
        body: json,
        auth: options.auth,
        allowLocalEndpoint: false,
      };
      return prepared;
    },

    parseCompletion(body) {
      return parseOpenAICompletionBody(body);
    },

    createStreamParser(): ProviderStreamParser {
      return createOpenAISSEParser();
    },
  };
}

/** Преобразует канонические инструменты в OpenAI-совместимый вид. */
export function toOpenAICompatibleTools(tools: readonly ProviderToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.map(toOpenAITool);
}

/** Строит query-суффикс из параметров endpoint (если есть). */
export function buildEndpointQuery(query?: Readonly<Record<string, string>>): string {
  if (!query) return "";
  const entries = Object.entries(query);
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}
