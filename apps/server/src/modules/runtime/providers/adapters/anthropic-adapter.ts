/**
 * Адаптер Anthropic-совместимых провайдеров (plan-24, Task 3).
 *
 * Реализует провода Anthropic Messages API (JSON + SSE с `event:`-событиями),
 * включая tool_use/input_json_delta и cache-usage.
 * Покрывает: anthropic, kimicodingplan (Anthropic-compatible).
 */

import type {
  ProviderAuthScheme,
  ProviderChatAdapter,
  ProviderPreparedRequest,
  ProviderStreamParser,
  ProviderToolDefinition,
} from "../provider-runtime-port.js";
import {
  serializeProviderJsonBody,
  toAnthropicMessage,
  toAnthropicTool,
} from "../provider-request.js";
import {
  buildEndpointQuery,
} from "./openai-compatible-adapter.js";
import {
  createAnthropicSSEParser,
  parseAnthropicCompletionBody,
} from "../provider-response.js";

export interface AnthropicCompatibleAdapterOptions {
  readonly providerId: string;
  readonly auth: ProviderAuthScheme;
  readonly chatPath?: string;
  readonly supportsStreaming?: boolean;
  readonly supportsToolCalls?: boolean;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Создаёт адаптер Anthropic-совместимого провайдера.
 */
export function createAnthropicCompatibleAdapter(options: AnthropicCompatibleAdapterOptions): ProviderChatAdapter {
  const chatPath = options.chatPath ?? "/v1/messages";

  return {
    providerId: options.providerId,
    protocolFamily: "anthropic-compatible",
    auth: options.auth,

    /** Строит HTTP-запрос Messages API. */
    buildRequest(input) {
      const systemBlocks: string[] = [];
      const messages = input.messages.filter((message) => {
        if (message.role === "system") {
          systemBlocks.push(
            typeof message.content === "string" ? message.content : "",
          );
          return false;
        }
        return true;
      });

      const body: Record<string, unknown> = {
        model: input.model,
        messages: messages.map(toAnthropicMessage),
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (systemBlocks.length > 0) {
        body.system = systemBlocks.filter((block) => block.length > 0);
      }
      if (input.tools && input.tools.length > 0 && options.supportsToolCalls !== false) {
        body.tools = input.tools.map(toAnthropicTool);
      }
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (input.stop && input.stop.length > 0) body.stop_sequences = input.stop;
      if (input.extraBody) {
        for (const [key, value] of Object.entries(input.extraBody)) {
          if (key !== "model" && key !== "messages" && key !== "max_tokens") body[key] = value;
        }
      }

      const json = serializeProviderJsonBody(body);
      const baseUrl = input.endpoint.replace(/\/+$/u, "");
      const path = chatPath.startsWith("/") ? chatPath : `/${chatPath}`;
      const query = buildEndpointQuery(input.endpointQuery);
      const url = `${baseUrl}${path}${query}`;
      const prepared: ProviderPreparedRequest = {
        method: "POST",
        url,
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: json,
        auth: options.auth,
        allowLocalEndpoint: false,
      };
      return prepared;
    },

    parseCompletion(body) {
      return parseAnthropicCompletionBody(body);
    },

    createStreamParser(): ProviderStreamParser {
      return createAnthropicSSEParser();
    },
  };
}

/** Преобразует канонические инструменты в Anthropic-вид. */
export function toAnthropicCompatibleTools(tools: readonly ProviderToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.map(toAnthropicTool);
}
