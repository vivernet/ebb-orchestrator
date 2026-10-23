/**
 * Канонический порт provider-рантайма (plan-24, Task 3).
 *
 * Порт задаёт единые типы для чат-запросов/ответов, стриминговых чанков,
 * usage, ошибок и привязки инструментов. Адаптеры провайдеров реализуют
 * `ProviderChatAdapter`; сетевой egress выполняется только через
 * `ProviderNetworkGateway`; управление run — через `ProviderAgentRuntime`.
 *
 * Инварианты:
 *  - никаких секретов и endpoint URL в этом файле — только определения типов;
 *  - ошибки провайдера несут только классификацию из таксономии
 *    (provider-errors), текст ошибки не удерживается;
 *  - usage.cost === null означает «источник не сообщил стоимость» и не
 *    подменяется оценкой или нулём.
 */

import type { ProviderErrorClassification } from "../provider-errors.js";

/** Семейство провода протокола провайдера (соответствует runtimeAdapterId каталога). */
export type ProviderProtocolFamily =
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama-native"
  | "google-generative"
  | "azure-openai"
  | "azure-ai-inference"
  | "cloudflare-workers-ai"
  | "huggingface-inference"
  | "aws-bedrock"
  | "google-vertex"
  | "image-rest"
  | "image-video-rest"
  | "replicate"
  | "comfyui"
  | "platform-cloud"
  | "gateway";

/** Роль сообщения в каноническом чат-диалоге. */
export type ProviderChatRole = "system" | "user" | "assistant" | "tool";

/** Часть содержимого сообщения (текст/изображение). */
export type ProviderContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

/** Вызов функции в сообщении assistant (соответствует OpenAI tool_calls). */
export interface ProviderToolCallFunction {
  readonly name: string;
  /** JSON-строка аргументов (как в проводе OpenAI). */
  readonly arguments: string;
}

export interface ProviderToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: ProviderToolCallFunction;
}

/** Каноническое сообщение диалога. */
export interface ProviderChatMessage {
  readonly role: ProviderChatRole;
  readonly content: string | readonly ProviderContentPart[];
  readonly name?: string;
  readonly toolCalls?: readonly ProviderToolCall[];
  readonly toolCallId?: string;
}

/** JSON Schema параметров инструмента (подмножество JSON Schema). */
export interface ProviderToolArgumentSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** Описание инструмента, передаваемое модели. */
export interface ProviderToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ProviderToolArgumentSchema;
  };
}

/** Вход канонического чат-запроса. */
export interface ProviderChatRequestInput {
  readonly model: string;
  readonly messages: readonly ProviderChatMessage[];
  readonly tools?: readonly ProviderToolDefinition[];
  readonly stream: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  /** Провайдер-специфичные дополнительные поля тела (не секреты). */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** Query-параметры endpoint (например api-version для Azure). */
  readonly endpointQuery?: Readonly<Record<string, string>>;
}

/** Канонический usage одной фазы ответа. */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** null — источник не сообщил стоимость; не подменяется оценкой. */
  readonly cost: number | null;
}

export const EMPTY_PROVIDER_USAGE: ProviderUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  cost: null,
});

/** Причина завершения генерации (каноническая). */
export type ProviderFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "other"
  | null;

/** Канонический завершённый ответ провайдера. */
export interface ProviderChatResponse {
  readonly id: string | null;
  readonly model: string | null;
  readonly content: string;
  readonly toolCalls: readonly ProviderToolCall[];
  readonly finishReason: ProviderFinishReason;
  readonly usage: ProviderUsage;
}

/** Типы чанков стримингового потока. */
export type ProviderStreamChunk =
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "tool-call-start"; readonly index: number; readonly id: string; readonly name: string }
  | { readonly kind: "tool-call-arguments"; readonly index: number; readonly argumentsDelta: string }
  | { readonly kind: "tool-call-end"; readonly index: number }
  | { readonly kind: "usage"; readonly usage: ProviderUsage }
  | { readonly kind: "finish"; readonly finishReason: ProviderFinishReason }
  | { readonly kind: "error"; readonly classification: ProviderErrorClassification };

/** Инкрементальный парсер стримингового потока провайдера. */
export interface ProviderStreamParser {
  /** Подаёт байтовый чанк и возвращает распознанные канонические события. */
  push(chunk: Uint8Array): readonly ProviderStreamChunk[];
  /** Завершает поток; бросает классифицированную ошибку при незавершённости. */
  finish(): void;
}

/** Способ передачи секретного credential в HTTP-запрос. */
export type ProviderAuthScheme =
  | { readonly kind: "bearer" }
  | { readonly kind: "header"; readonly headerName: string }
  | { readonly kind: "query"; readonly paramName: string }
  | { readonly kind: "none" };

/** HTTP-спецификация запроса к провайдеру (вход сетевого шлюза). */
export interface ProviderPreparedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string | Buffer>>;
  readonly body: string | null;
  /** Схема прикрепления секрета; значение секрета подставляет рантайм. */
  readonly auth: ProviderAuthScheme;
  /**
   * true — провайдер объявляет поддержку локального endpoint И пользователь
   * явно указал точный локальный/частный endpoint. Разрешает частные/локальные
   * диапазоны в шлюзе; метаданные-адреса блокируются всегда.
   */
  readonly allowLocalEndpoint: boolean;
  readonly timeoutMs?: number;
}

/** Спецификация адаптера чат-провайдера (порт). */
export interface ProviderChatAdapter {
  readonly providerId: string;
  readonly protocolFamily: ProviderProtocolFamily;
  readonly auth: ProviderAuthScheme;

  /** Строит подготовленный HTTP-запрос из канонического входа. */
  buildRequest(input: ProviderChatRequestInput & { readonly endpoint: string }): ProviderPreparedRequest;

  /** Разбирает не-стриминговый JSON-ответ в канонический ответ. */
  parseCompletion(body: unknown): ProviderChatResponse;

  /** Создаёт парсер стримингового потока провайдера. */
  createStreamParser(): ProviderStreamParser;

  /**
   * Хук валидации структурированного результата (ролевой контракт).
   * Опционален: используется для structured-output контрактов.
   */
  validateStructuredResult?(role: string, payload: unknown): {
    valid: boolean;
    output?: unknown;
    error?: string;
  };
}

/** Ссылка на конфигурацию адаптера для конкретного провайдера. */
export interface ProviderAdapterConfigReference {
  readonly providerId: string;
  readonly family: ProviderProtocolFamily;
  readonly auth: ProviderAuthScheme;
  /** Путь чат-эндпоинта относительно базового URL (например `/chat/completions`). */
  readonly chatPath: string;
  /** Базовый URL по умолчанию, когда у провайдера нет endpoint-конфигурации. */
  readonly defaultBaseUrl?: string;
  /** true — требуется `endpoint` из пользовательской конфигурации. */
  readonly requiresEndpointConfig: boolean;
  /**
   * Кастомное разрешение endpoint (например Azure: host из resourceName,
   * путь из deploymentName). По умолчанию — `resolveProviderEndpoint`.
   */
  readonly resolveEndpoint?: (config: Readonly<Record<string, unknown>> | undefined) => ResolvedProviderEndpoint;
  /** Query-параметры, добавляемые к URL запроса (например api-version). */
  readonly endpointQuery?: (config: Readonly<Record<string, unknown>> | undefined) => Readonly<Record<string, string>>;
  readonly supportsStreaming: boolean;
  readonly supportsToolCalls: boolean;
  readonly capabilities: readonly string[];
  /** Фабрика создания экземпляра адаптера. */
  readonly create: () => ProviderChatAdapter;
}

/** Итог разрешения endpoint для запроса: URL + признак локального endpoint. */
export interface ResolvedProviderEndpoint {
  readonly baseUrl: string;
  readonly isLocalEndpoint: boolean;
}

/** Провайдер не поддерживает чат-запросы (image/video-платформы). */
export const PROVIDER_CAPABILITY_UNSUPPORTED = "PROVIDER_CAPABILITY_UNSUPPORTED" as const;

/** Класс ошибки адаптера/рантайма с типизированной классификацией. */
export class ProviderCapabilityError extends Error {
  public readonly code: typeof PROVIDER_CAPABILITY_UNSUPPORTED = PROVIDER_CAPABILITY_UNSUPPORTED;
  public constructor(providerId: string, capability: string) {
    super(`PROVIDER_CAPABILITY_UNSUPPORTED:${providerId}:${capability}`);
    this.name = "ProviderCapabilityError";
  }
}
