/**
 * Адаптер Ollama-native (plan-24, Task 3).
 *
 * Реализует провода `/api/chat` Ollama (JSON/NDJSON), включая tool_calls.
 * Покрывает: ollama (local-endpoint).
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
} from "../provider-request.js";
import {
  buildEndpointQuery,
} from "./openai-compatible-adapter.js";
import {
  createOllamaNDJSParser,
  parseOllamaCompletionBody,
} from "./ollama-stream-parser.js";

export interface OllamaNativeAdapterOptions {
  readonly providerId: string;
  readonly auth: ProviderAuthScheme;
  readonly chatPath?: string;
  readonly supportsToolCalls?: boolean;
}

/**
 * Создаёт адаптер Ollama-native.
 */
export function createOllamaNativeAdapter(options: OllamaNativeAdapterOptions): ProviderChatAdapter {
  const chatPath = options.chatPath ?? "/api/chat";

  return {
    providerId: options.providerId,
    protocolFamily: "ollama-native",
    auth: options.auth,

    buildRequest(input) {
      const messages = input.messages.map((message) => {
        const base: Record<string, unknown> = {
          role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "user" : message.role,
        };
        if (message.role === "tool") {
          base.content = typeof message.content === "string"
            ? message.content
            : `[tool result for ${message.toolCallId ?? "unknown"}]`;
          return base;
        }
        if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
          base.content = typeof message.content === "string" ? message.content : "";
          base.tool_calls = message.toolCalls.map((call) => ({
            function: { name: call.function.name, arguments: safeParseArguments(call.function.arguments) },
          }));
          return base;
        }
        base.content = typeof message.content === "string" ? message.content : "";
        return base;
      });

      const body: Record<string, unknown> = {
        model: input.model,
        messages,
        stream: input.stream,
      };
      if (input.tools && input.tools.length > 0 && options.supportsToolCalls !== false) {
        body.tools = input.tools.map((tool: ProviderToolDefinition) => ({
          type: "function",
          function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters },
        }));
      }
      if (input.temperature !== undefined) body.options = { ...(body.options as Record<string, unknown> | undefined), temperature: input.temperature };
      if (input.maxTokens !== undefined) body.options = { ...(body.options as Record<string, unknown> | undefined), num_predict: input.maxTokens };
      if (input.extraBody) {
        for (const [key, value] of Object.entries(input.extraBody)) {
          if (key !== "model" && key !== "messages" && key !== "stream") body[key] = value;
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
        headers: { "content-type": "application/json" },
        body: json,
        auth: options.auth,
        allowLocalEndpoint: false,
      };
      return prepared;
    },

    parseCompletion(body) {
      return parseOllamaCompletionBody(body);
    },

    createStreamParser(): ProviderStreamParser {
      return createOllamaNDJSParser();
    },
  };
}

function safeParseArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
