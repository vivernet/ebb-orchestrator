/**
 * Канонический конструктор запросов к провайдерам (plan-24, Task 3).
 *
 * Обеспечивает единый контракт построения HTTP-запроса из канонического
 * входа (`ProviderChatRequestInput`) через адаптер, включая:
 *  - нормализацию сообщений и инструментов;
 *  - лимиты размера тела запроса;
 *  - разрешение endpoint из конфигурации провайдера (пользовательский
 *    endpoint или дефолт провайдера) и флаг разрешения локального endpoint.
 */

import { ProviderRuntimeError } from "./provider-error-mapper.js";
import type {
  ProviderAdapterConfigReference,
  ProviderChatMessage,
  ProviderChatRequestInput,
  ProviderChatRole,
  ProviderPreparedRequest,
  ProviderToolCall,
  ProviderToolDefinition,
  ResolvedProviderEndpoint,
} from "./provider-runtime-port.js";
import type { ProviderConfigSnapshotRecord } from "./provider-settings-repository.js";

/** Максимальный размер тела запроса к провайдеру (JSON), байт. */
export const MAX_PROVIDER_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** Сериализует тело запроса с проверкой размера. */
export function serializeProviderJsonBody(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", "REQUEST_BODY_NOT_SERIALIZABLE");
  }
  if (json === undefined) throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", "REQUEST_BODY_UNDEFINED");
  if (json.length > MAX_PROVIDER_REQUEST_BODY_BYTES) {
    throw new ProviderRuntimeError("NETWORK_RESPONSE_TOO_LARGE", "REQUEST_BODY_TOO_LARGE");
  }
  return json;
}

/** Нормализует содержимое сообщения в строку (текстовую). */
export function messageText(message: ProviderChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

/** Нормализует сообщение в OpenAI-совместимый вид. */
export function toOpenAIMessage(message: ProviderChatMessage): Record<string, unknown> {
  const role = message.role as ProviderChatRole;
  const base: Record<string, unknown> = { role };
  if (role === "tool") {
    base.tool_call_id = message.toolCallId ?? "";
    base.content = messageText(message);
    return base;
  }
  if (role === "assistant") {
    if (message.toolCalls && message.toolCalls.length > 0) {
      base.content = messageText(message);
      base.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
      return base;
    }
  }
  if (message.name) base.name = message.name;
  base.content = messageText(message);
  return base;
}

/** Нормализует сообщение в Anthropic-совместимый вид. */
export function toAnthropicMessage(message: ProviderChatMessage): Record<string, unknown> {
  const role = message.role === "system" ? "user" : message.role === "tool" ? "user" : message.role;
  const base: Record<string, unknown> = { role };
  if (role === "user") {
    if (message.toolCallId) {
      base.content = [
        { type: "tool_result", tool_use_id: message.toolCallId, content: messageText(message) },
      ];
      return base;
    }
    base.content = [{ type: "text", text: messageText(message) }];
    return base;
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (messageText(message).length > 0) blocks.push({ type: "text", text: messageText(message) });
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: safeParseArguments(call.function.arguments) ?? {},
    });
  }
  base.content = blocks;
  return base;
}

/** Безопасный разбор JSON-аргументов инструмента (null при невалидном JSON). */
export function safeParseArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Нормализует инструмент в OpenAI-вид. */
export function toOpenAITool(tool: ProviderToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}

/** Нормализует инструмент в Anthropic-вид. */
export function toAnthropicTool(tool: ProviderToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}

/**
 * Разрешает endpoint запроса из конфигурации и ссылки на конфигурацию
 * адаптера. Возвращает базовый URL и признак локального/частного endpoint.
 * Итоговое разрешение локального endpoint в шлюзе вычисляет рантайм:
 * (провайдер объявляет local-endpoint поддержку) И (endpoint локальный).
 */
export function resolveProviderEndpoint(
  reference: ProviderAdapterConfigReference,
  config: Readonly<Record<string, unknown>> | undefined,
): ResolvedProviderEndpoint {
  const rawEndpoint = typeof config?.endpoint === "string" ? config.endpoint.trim() : "";

  if (rawEndpoint.length > 0) {
    const url = new URL(rawEndpoint);
    return {
      baseUrl: rawEndpoint.replace(/\/+$/u, ""),
      isLocalEndpoint: isLocalOrPrivateEndpoint(url),
    };
  }

  if (!reference.requiresEndpointConfig) {
    if (reference.defaultBaseUrl) return { baseUrl: reference.defaultBaseUrl, isLocalEndpoint: false };
    throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING");
  }

  throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING");
}

function isLocalOrPrivateEndpoint(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ipPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (ipPattern) {
    const octets = ipPattern.slice(1).map((part) => Number(part));
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (/^[0-9a-f:]+$/iu.test(host) && host.includes(":")) return true;
  return false;
}

/** Строит подготовленный HTTP-запрос из канонического входа через адаптер. */
export function buildProviderRequest(
  adapter: { buildRequest(input: ProviderChatRequestInput & { readonly endpoint: string }): ProviderPreparedRequest },
  input: ProviderChatRequestInput & { readonly endpoint: string },
): ProviderPreparedRequest {
  return adapter.buildRequest(input);
}

/**
 * Прикрепляет секретный credential к подготовленному запросу (схема auth).
 * Значение credential принимается только как `Uint8Array` (Buffer) — байты
 * секрета, — чтобы не создавать необнуляемых строковых копий в заголовках.
 * Для header/bearer-схем Buffer-значения либо разделяют память с исходным
 * credential, либо являются его Buffer-копией (обнуляемой после использования);
 * query-схема требует строку в URL (неизбежный GC-only участок) — конвертация
 * выполняется здесь через `TextDecoder` без промежуточной копии наружу.
 */
export function attachCredentialToRequest(
  request: ProviderPreparedRequest,
  credentialHeaderValue: Uint8Array | null,
): { url: string; headers: Record<string, string | Buffer>; body: string | null } {
  const headers: Record<string, string | Buffer> = { ...request.headers };
  let url = request.url;
  if (request.auth.kind === "bearer") {
    if (credentialHeaderValue === null) throw new ProviderRuntimeError("AUTH_DEVICE_FLOW_TOKEN_MISSING");
    headers.authorization = Buffer.concat([Buffer.from("Bearer "), credentialHeaderValue]);
  } else if (request.auth.kind === "header") {
    headers[request.auth.headerName] = credentialHeaderValue === null
      ? ""
      : Buffer.from(credentialHeaderValue.buffer, credentialHeaderValue.byteOffset, credentialHeaderValue.byteLength);
  } else if (request.auth.kind === "query") {
    if (credentialHeaderValue === null) throw new ProviderRuntimeError("AUTH_DEVICE_FLOW_TOKEN_MISSING");
    const parsed = new URL(request.url);
    parsed.searchParams.set(request.auth.paramName, new TextDecoder().decode(credentialHeaderValue));
    url = parsed.toString();
  }
  return { url, headers, body: request.body };
}

/** Возвращает копию tool_calls с безопасным названием (валидация имени ToolId). */
export function normalizeToolCalls(calls: readonly ProviderToolCall[]): readonly ProviderToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.function.name.slice(0, 256),
      arguments: call.function.arguments.slice(0, 64 * 1024),
    },
  }));
}

/** Извлекает несекретную конфигурацию из снимка. */
export function configFromSnapshot(snapshot: ProviderConfigSnapshotRecord | undefined): Readonly<Record<string, unknown>> | undefined {
  return snapshot?.config;
}
