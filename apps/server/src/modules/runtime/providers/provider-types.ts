/**
 * Типы каталога AI-провайдеров Ebb (plan-24, Task 1).
 *
 * Типы описывают идентичность, способы авторизации, схемы credential/config-полей,
 * источник моделей и возможности провайдера. Значения секретов и endpoint URL
 * здесь не хранятся — только определения полей.
 */

/** Способы аутентификации провайдера (plan-24, Task 1). */
export type ProviderAuthMethod =
  | 'api-key'
  | 'credential-fields'
  | 'subscription-token'
  | 'oauth-device-code'
  | 'oauth-pkce'
  | 'cloud-identity'
  | 'local-endpoint';

/** Категория провайдера по основной модельной линии. */
export type ProviderCategory =
  | 'chat'
  | 'image'
  | 'video'
  | 'embedding'
  | 'platform'
  | 'gateway'
  | 'local';

/** Возможности провайдера/модели (plan-24, Task 1). */
export type ProviderCapability =
  | 'chat'
  | 'streaming'
  | 'toolCalling'
  | 'structuredOutput'
  | 'vision'
  | 'audio'
  | 'imageGeneration'
  | 'videoGeneration'
  | 'embeddings'
  | 'reranking';

/** Тип модели в каталоге (подмножество типов источника LobeHub). */
export type ModelType = 'chat' | 'image' | 'video' | 'embedding';

/** Вид credential-поля. Токены OAuth помечены как управляемые auth-flow. */
export type CredentialFieldKind =
  | 'api-key'
  | 'access-key-id'
  | 'secret-access-key'
  | 'session-token'
  | 'oauth-access-token'
  | 'oauth-refresh-token'
  | 'bearer-token';

/** Вид несекретного config-поля. */
export type ConfigFieldKind =
  | 'endpoint'
  | 'string'
  | 'account-id'
  | 'deployment-name'
  | 'resource-name'
  | 'region'
  | 'project-id'
  | 'api-version'
  | 'fetcher-url'
  | 'deploy-name'
  | 'boolean';

/** Определение одного credential-поля (без значений). */
export interface CredentialFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly kind: CredentialFieldKind;
  readonly required: boolean;
  /** True для токенов, которыми управляет OAuth/device-flow, а не пользователь. */
  readonly managedByAuthFlow?: boolean;
}

/** Схема credentials провайдера: только определения полей, никаких значений. */
export interface CredentialSchema {
  readonly version: number;
  readonly fields: readonly CredentialFieldDefinition[];
}

/** Определение одного несекретного config-поля (без значений). */
export interface ConfigFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly kind: ConfigFieldKind;
  readonly required: boolean;
  readonly placeholder?: string;
}

/** Схема несекретной конфигурации провайдера. */
export interface ConfigSchema {
  readonly version: number;
  readonly fields: readonly ConfigFieldDefinition[];
}

/**
 * Описание источника моделей провайдера.
 *
 * - `builtin` — статичный список моделей в каталоге Ebb;
 * - `remote` — модели загружаются из API провайдера (providerCatalog), статичных нет;
 * - `builtin-and-remote` — статичный список + API-каталог;
 * - `static-platform` — платформенный список (например, LobeHub);
 * - `derived` — список производный от другого провайдера (например, ChatGPT от OpenAI).
 */
export type ProviderModelSourceInfo = {
  readonly kind: 'builtin' | 'remote' | 'builtin-and-remote' | 'static-platform' | 'derived';
  /** Провайдер-источник для `derived`. */
  readonly derivedFrom?: string;
  /** Количество моделей в статичном списке каталога. */
  readonly modelCount: number;
  /** Есть ли загрузка списка моделей из API провайдера. */
  readonly providerCatalog: boolean;
  /** Разрешены ли пользовательские имена моделей. */
  readonly userCustom: boolean;
  /** Локальный/self-hosted endpoint. */
  readonly localEndpoint: boolean;
};

/** Определение провайдера в каталоге Ebb (plan-24, Task 1). */
export interface ProviderDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly category: ProviderCategory;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly credentialSchema: CredentialSchema;
  readonly configSchema: ConfigSchema;
  readonly modelSource: ProviderModelSourceInfo;
  readonly capabilities: readonly ProviderCapability[];
  readonly runtimeAdapterId: string;
}

/** Идентичность модели: всегда пара (providerId, modelId), никогда не голый modelId. */
export interface ModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

/** Запись модельного каталога (plan-24, Task 1). */
export interface ProviderModelEntry extends ModelIdentity {
  readonly displayName: string;
  readonly type: ModelType;
  readonly capabilities: readonly ProviderCapability[];
  readonly contextWindowTokens?: number;
  readonly maxOutput?: number;
}
