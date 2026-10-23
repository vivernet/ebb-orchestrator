/**
 * Адаптер Google Generative Language API (plan-24, Task 3).
 *
 * Реализует провода `models/{model}:generateContent` / `:streamGenerateContent`
 * (JSON/SSE), включая functionDeclarations/functionCall.
 * Покрывает: google (google-generative).
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
  createGoogleGenerativeSSEParser,
  parseGoogleGenerativeCompletionBody,
} from "./google-stream-parser.js";

export interface GoogleGenerativeAdapterOptions {
  readonly providerId: string;
  readonly auth: ProviderAuthScheme;
  /** Путь к generateContent (без модели); по умолчанию `/models`. */
  readonly modelsPath?: string;
  readonly supportsStreaming?: boolean;
  readonly supportsToolCalls?: boolean;
}

/**
 * Создаёт адаптер Google Generative Language.
 */
export function createGoogleGenerativeAdapter(options: GoogleGenerativeAdapterOptions): ProviderChatAdapter {
  const modelsPath = options.modelsPath ?? "/models";

  const buildGenerateUrl = (endpoint: string, model: string, stream: boolean): string => {
    const baseUrl = endpoint.replace(/\/+$/u, "");
    const method = stream ? ":streamGenerateContent" : ":generateContent";
    return `${baseUrl}${modelsPath}/${encodeURIComponent(model)}${method}?alt=sse`;
  };

  return {
    providerId: options.providerId,
    protocolFamily: "google-generative",
    auth: options.auth,

    buildRequest(input) {
      const contents: Array<Record<string, unknown>> = [];
      let systemInstruction: string | null = null;

      for (const message of input.messages) {
        if (message.role === "system") {
          systemInstruction = typeof message.content === "string" ? message.content : "";
          continue;
        }
        const role = message.role === "assistant" ? "model" : "user";
        const parts: Array<Record<string, unknown>> = [];
        if (typeof message.content === "string" && message.content.length > 0) {
          parts.push({ text: message.content });
        }
        if (message.role === "assistant") {
          for (const call of message.toolCalls ?? []) {
            parts.push({
              functionCall: {
                name: call.function.name,
                args: safeParseArguments(call.function.arguments) ?? {},
              },
            });
          }
        }
        if (message.role === "tool" && message.toolCallId) {
          parts.push({
            functionResponse: {
              name: message.toolCallId,
              response: { content: typeof message.content === "string" ? message.content : "" },
            },
          });
        }
        if (parts.length === 0) continue;
        contents.push({ role, parts });
      }

      const body: Record<string, unknown> = { contents };
      if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
      if (input.tools && input.tools.length > 0 && options.supportsToolCalls !== false) {
        body.tools = [
          {
            functionDeclarations: input.tools.map((tool: ProviderToolDefinition) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            })),
          },
        ];
      }
      if (input.temperature !== undefined || input.maxTokens !== undefined) {
        const generationConfig: Record<string, unknown> = {};
        if (input.temperature !== undefined) generationConfig.temperature = input.temperature;
        if (input.maxTokens !== undefined) generationConfig.maxOutputTokens = input.maxTokens;
        body.generationConfig = generationConfig;
      }
      if (input.extraBody) {
        for (const [key, value] of Object.entries(input.extraBody)) {
          if (key !== "contents" && key !== "systemInstruction" && key !== "tools") body[key] = value;
        }
      }

      const json = serializeProviderJsonBody(body);
      const url = buildGenerateUrl(input.endpoint, input.model, input.stream);
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
      return parseGoogleGenerativeCompletionBody(body);
    },

    createStreamParser(): ProviderStreamParser {
      return createGoogleGenerativeSSEParser();
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
