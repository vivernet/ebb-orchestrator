/**
 * Каталог AI-провайдеров Ebb (plan-24, Task 1).
 *
 * Версионированный Ebb-owned каталог всех 86 provider ID закреплённого источника
 * LobeHub (commit `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`).
 * Источник данных — утверждённый evidence-документ Task 0
 * (`docs/architecture/plans/evidence/24-provider-inventory.md`).
 *
 * Контракты:
 *  - каталог содержит ровно 86 записей; `id` — стабильные строковые литералы
 *    в записях (разбираются скриптом `scripts/provider-inventory-check.mjs`);
 *  - не содержит секретных значений и endpoint URL — только определения полей;
 *  - неизвестный провайдер завершается fail-closed (`getProvider` → undefined,
 *    `assertProviderKnown` бросает `PROVIDER_UNKNOWN`);
 *  - публичная проекция (`toSafeProviderProjection`) безопасна для Web/API и
 *    совпадает с `PROVIDER_CATALOG_PROJECTION` из `@ebb-orchestrator/contracts`.
 */

import {
  PROVIDER_CATALOG_PROJECTION,
  type ProviderCatalogEntryProjection,
} from '@ebb-orchestrator/contracts';

import type {
  ConfigFieldDefinition,
  ConfigSchema,
  CredentialFieldDefinition,
  CredentialSchema,
  ProviderAuthMethod,
  ProviderCapability,
  ProviderCategory,
  ProviderDefinition,
  ProviderModelSourceInfo,
} from './provider-types.js';

/** Версия каталога провайдеров — инкрементируется при изменении состава записей. */
export const PROVIDER_CATALOG_VERSION = 1 as const;

/** Закреплённый источник LobeHub (plan-24, Authority). */
export const PROVIDER_CATALOG_SOURCE_PIN = 'd1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1' as const;

const API_KEY_AUTH: readonly ProviderAuthMethod[] = ['api-key'];
const SUBSCRIPTION_TOKEN_AUTH: readonly ProviderAuthMethod[] = ['subscription-token'];
const OAUTH_DEVICE_CODE_AUTH: readonly ProviderAuthMethod[] = ['oauth-device-code'];
const LOCAL_ENDPOINT_AUTH: readonly ProviderAuthMethod[] = ['local-endpoint'];
const LOCAL_ENDPOINT_OPTIONAL_API_KEY_AUTH: readonly ProviderAuthMethod[] = ['local-endpoint', 'api-key'];
const BEDROCK_AUTH: readonly ProviderAuthMethod[] = ['credential-fields', 'cloud-identity'];
const VERTEX_AI_AUTH: readonly ProviderAuthMethod[] = ['api-key', 'cloud-identity'];

/**
 * Определения credential-полей (без значений).
 * Для OAuth/device-провайдеров токены помечены `managedByAuthFlow` — они не
 * вводятся пользователем, а обмениваются flow-ом (Task 4).
 */

function apiKeyField(required = true, label = 'API-ключ'): CredentialFieldDefinition {
  return { name: 'apiKey', label, kind: 'api-key', required };
}

function oauthTokenFields(includeBearer = false): readonly CredentialFieldDefinition[] {
  const fields: CredentialFieldDefinition[] = [
    { name: 'oauthAccessToken', label: 'Токен доступа OAuth', kind: 'oauth-access-token', required: true, managedByAuthFlow: true },
    { name: 'oauthRefreshToken', label: 'Refresh-токен OAuth', kind: 'oauth-refresh-token', required: false, managedByAuthFlow: true },
  ];
  if (includeBearer) {
    fields.push({ name: 'bearerToken', label: 'Bearer-токен Copilot', kind: 'bearer-token', required: false, managedByAuthFlow: true });
  }
  return fields;
}

function awsCredentialFields(): readonly CredentialFieldDefinition[] {
  return [
    { name: 'accessKeyId', label: 'Access Key ID', kind: 'access-key-id', required: true },
    { name: 'secretAccessKey', label: 'Secret Access Key', kind: 'secret-access-key', required: true },
    { name: 'sessionToken', label: 'Session Token', kind: 'session-token', required: false },
  ];
}

/**
 * Определения несекретных config-полей (без значений).
 * `fetcher` — переключатель загрузки списка моделей из API провайдера
 * (showModelFetcher в источнике).
 */

function endpointField(required = true): ConfigFieldDefinition {
  return { name: 'endpoint', label: 'Endpoint API', kind: 'endpoint', required };
}

function fetcherField(): ConfigFieldDefinition {
  return { name: 'fetcher', label: 'Загружать список моделей из API провайдера', kind: 'boolean', required: false };
}

function deployNameField(): ConfigFieldDefinition {
  return { name: 'deployName', label: 'Имя развёртывания', kind: 'deploy-name', required: true };
}

function deploymentNameField(): ConfigFieldDefinition {
  return { name: 'deploymentName', label: 'Имя развёртывания', kind: 'deployment-name', required: true };
}

function resourceNameField(): ConfigFieldDefinition {
  return { name: 'resourceName', label: 'Имя ресурса Azure', kind: 'resource-name', required: true };
}

function apiVersionField(): ConfigFieldDefinition {
  return { name: 'apiVersion', label: 'Версия API', kind: 'api-version', required: false };
}

function accountIdField(): ConfigFieldDefinition {
  return { name: 'accountId', label: 'ID аккаунта', kind: 'account-id', required: true };
}

function regionField(): ConfigFieldDefinition {
  return { name: 'region', label: 'Регион', kind: 'region', required: true };
}

function projectIdField(): ConfigFieldDefinition {
  return { name: 'projectId', label: 'ID проекта', kind: 'project-id', required: true };
}

const EMPTY_CONFIG_FIELDS: readonly ConfigFieldDefinition[] = [];

function schema(fields: readonly CredentialFieldDefinition[]): CredentialSchema {
  return { version: 1, fields };
}

function configSchema(fields: readonly ConfigFieldDefinition[]): ConfigSchema {
  return { version: 1, fields };
}

function caps(...values: ProviderCapability[]): readonly ProviderCapability[] {
  return values;
}

/**
 * Парсит строковую спецификацию источника моделей из evidence (колонка
 * modelSource таблицы B) в структурированный `ProviderModelSourceInfo`.
 *
 * Форматы: `builtin:N`, `remote+builtin:N`, `remote`, `static(platform)`,
 * `builtin(derived from OpenAI)`, опциональный суффикс `+local`.
 * `modelCountOverride` позволяет уточнить количество статичных моделей там, где
 * evidence включал закомментированные записи источника (bedrock, giteeai,
 * nebius) или производный список (chatgpt, lobehub).
 */
function source(spec: string, modelCountOverride?: number): ProviderModelSourceInfo {
  const localEndpoint = spec.endsWith('+local');
  const body = spec.replace(/\+local$/, '');
  const derivedMatch = /^builtin\(derived from ([a-z]+)\)$/i.exec(body);
  const derivedFrom = derivedMatch?.[1];
  if (derivedFrom) {
    return {
      kind: 'derived',
      derivedFrom: derivedFrom.toLowerCase(),
      modelCount: modelCountOverride ?? 0,
      providerCatalog: false,
      userCustom: false,
      localEndpoint,
    };
  }
  if (body === 'static(platform)') {
    return { kind: 'static-platform', modelCount: modelCountOverride ?? 0, providerCatalog: false, userCustom: false, localEndpoint };
  }
  if (body === 'remote') {
    return { kind: 'remote', modelCount: 0, providerCatalog: true, userCustom: true, localEndpoint };
  }
  const remote = body.startsWith('remote+');
  const countPart = /:(\d+)$/.exec(body);
  const modelCount = modelCountOverride ?? (countPart ? Number(countPart[1]) : 0);
  return {
    kind: remote ? 'builtin-and-remote' : 'builtin',
    modelCount,
    providerCatalog: remote,
    // В источнике пользовательские модели разрешены по умолчанию; явно отключены
    // только у первой-party платформы (showAddNewModel: false у lobehub).
    userCustom: true,
    localEndpoint,
  };
}

/**
 * Выводит категорию провайдера по auth-методам и адаптеру runtime.
 * Локальные self-hosted провайдеры → local; платформа/шлюз — по протоколу;
 * image-only провайдеры (bfl/fal/replicate) → image; остальные — chat.
 */
function categoryFor(authMethods: readonly ProviderAuthMethod[], adapterId: string): ProviderCategory {
  if (authMethods.includes('local-endpoint')) return 'local';
  switch (adapterId) {
    case 'platform-cloud':
      return 'platform';
    case 'gateway':
      return 'gateway';
    case 'image-rest':
    case 'image-video-rest':
    case 'replicate':
    case 'comfyui':
      return 'image';
    default:
      return 'chat';
  }
}

/** Заготовка записи каталога (данные — из evidence Task 0). */
interface ProviderSeed {
  readonly id: string;
  readonly displayName: string;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly credentialFields: readonly CredentialFieldDefinition[];
  readonly configFields: readonly ConfigFieldDefinition[];
  readonly capabilities: readonly ProviderCapability[];
  readonly modelSourceSpec: string;
  readonly modelCountOverride?: number;
  readonly runtimeAdapterId: string;
}

/**
 * Заготовки 86 записей каталога. Строковые литералы `id: '...'` — контракт
 * скрипта `scripts/provider-inventory-check.mjs` (regex `id: '...'`).
 */
const SEEDS: readonly ProviderSeed[] = [
  { id: 'ai21', displayName: 'Ai21Labs', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:2', runtimeAdapterId: 'openai-compatible' },
  { id: 'ai302', displayName: '302.AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:17', runtimeAdapterId: 'openai-compatible' },
  { id: 'ai360', displayName: '360 AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:20', runtimeAdapterId: 'openai-compatible' },
  { id: 'aihubmix', displayName: 'AIHubMix', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'structuredOutput', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:68', runtimeAdapterId: 'openai-router' },
  { id: 'akashchat', displayName: 'AkashChat', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'antgroup', displayName: 'AntGroup', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:4', runtimeAdapterId: 'openai-compatible' },
  { id: 'anthropic', displayName: 'Anthropic', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:13', runtimeAdapterId: 'anthropic-compatible' },
  { id: 'azure', displayName: 'Azure OpenAI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [resourceNameField(), deploymentNameField(), apiVersionField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:31', runtimeAdapterId: 'azure-openai' },
  { id: 'azureai', displayName: 'Azure AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), deploymentNameField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:13', runtimeAdapterId: 'azure-ai-inference' },
  { id: 'baichuan', displayName: 'Baichuan', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:10', runtimeAdapterId: 'openai-compatible' },
  { id: 'bailiancodingplan', displayName: 'Aliyun Bailian Coding Plan', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), deployNameField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:8', runtimeAdapterId: 'openai-compatible' },
  { id: 'bedrock', displayName: 'Bedrock', authMethods: BEDROCK_AUTH, credentialFields: awsCredentialFields(), configFields: [regionField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:26', modelCountOverride: 23, runtimeAdapterId: 'aws-bedrock' },
  { id: 'bfl', displayName: 'Black Forest Labs', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('imageGeneration'), modelSourceSpec: 'builtin:6', runtimeAdapterId: 'image-rest' },
  { id: 'cerebras', displayName: 'Cerebras', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:2', runtimeAdapterId: 'openai-compatible' },
  { id: 'chatgpt', displayName: 'ChatGPT', authMethods: OAUTH_DEVICE_CODE_AUTH, credentialFields: oauthTokenFields(), configFields: [endpointField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'builtin(derived from OpenAI)', modelCountOverride: 8, runtimeAdapterId: 'openai-compatible' },
  { id: 'cloudflare', displayName: 'Cloudflare Workers AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [accountIdField(), endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:7', runtimeAdapterId: 'cloudflare-workers-ai' },
  { id: 'cohere', displayName: 'Cohere', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'cometapi', displayName: 'CometAPI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:28', runtimeAdapterId: 'openai-compatible' },
  { id: 'comfyui', displayName: 'ComfyUI', authMethods: LOCAL_ENDPOINT_OPTIONAL_API_KEY_AUTH, credentialFields: [apiKeyField(false)], configFields: [endpointField()], capabilities: caps('imageGeneration'), modelSourceSpec: 'builtin:11+local', runtimeAdapterId: 'comfyui' },
  { id: 'deepseek', displayName: 'DeepSeek', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'fal', displayName: 'Fal', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('imageGeneration', 'videoGeneration'), modelSourceSpec: 'builtin:12', runtimeAdapterId: 'image-video-rest' },
  { id: 'fireworksai', displayName: 'Fireworks AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:22', runtimeAdapterId: 'openai-compatible' },
  { id: 'giteeai', displayName: 'Gitee AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:36', modelCountOverride: 35, runtimeAdapterId: 'openai-compatible' },
  { id: 'github', displayName: 'GitHub', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField(true, 'Персональный токен (PAT)')], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:44', runtimeAdapterId: 'azure-openai' },
  { id: 'githubcopilot', displayName: 'GitHub Copilot', authMethods: OAUTH_DEVICE_CODE_AUTH, credentialFields: oauthTokenFields(true), configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'structuredOutput', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:20', runtimeAdapterId: 'openai-compatible' },
  { id: 'glmcodingplan', displayName: 'GLM Coding Plan', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), deployNameField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'google', displayName: 'Google', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:25', runtimeAdapterId: 'google-generative' },
  { id: 'groq', displayName: 'Groq', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:9', runtimeAdapterId: 'openai-compatible' },
  { id: 'higress', displayName: 'Higress', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:199', runtimeAdapterId: 'openai-compatible' },
  { id: 'huggingface', displayName: 'HuggingFace', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField(true, 'API-ключ (HF token)')], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:9', runtimeAdapterId: 'huggingface-inference' },
  { id: 'hunyuan', displayName: 'Hunyuan', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:24', runtimeAdapterId: 'openai-compatible' },
  { id: 'infiniai', displayName: 'InfiniAI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:42', runtimeAdapterId: 'openai-compatible' },
  { id: 'internlm', displayName: 'InternLM', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'jina', displayName: 'Jina AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:1', runtimeAdapterId: 'openai-compatible' },
  { id: 'kimicodingplan', displayName: 'Kimi Code', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), deployNameField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:2', runtimeAdapterId: 'anthropic-compatible' },
  { id: 'lmstudio', displayName: 'LM Studio', authMethods: LOCAL_ENDPOINT_AUTH, credentialFields: [], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:2+local', runtimeAdapterId: 'openai-compatible' },
  { id: 'lobehub', displayName: 'LobeHub', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('chat', 'streaming'), modelSourceSpec: 'static(platform)', modelCountOverride: 4, runtimeAdapterId: 'platform-cloud' },
  { id: 'longcat', displayName: 'LongCat', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:1', runtimeAdapterId: 'openai-compatible' },
  { id: 'meta', displayName: 'Meta', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:1', runtimeAdapterId: 'openai-compatible' },
  { id: 'minimax', displayName: 'Minimax', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:25', runtimeAdapterId: 'openai-compatible' },
  { id: 'minimaxcodingplan', displayName: 'MiniMax Token Plan', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), deployNameField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:6', runtimeAdapterId: 'openai-compatible' },
  { id: 'mistral', displayName: 'Mistral', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:8', runtimeAdapterId: 'openai-compatible' },
  { id: 'modelscope', displayName: 'ModelScope', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'moonshot', displayName: 'Moonshot', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:4', runtimeAdapterId: 'openai-compatible' },
  { id: 'nebius', displayName: 'Nebius', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'embeddings', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:4', modelCountOverride: 3, runtimeAdapterId: 'openai-compatible' },
  { id: 'newapi', displayName: 'New API', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'structuredOutput'), modelSourceSpec: 'remote', runtimeAdapterId: 'openai-router' },
  { id: 'novita', displayName: 'Novita', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:61', runtimeAdapterId: 'openai-compatible' },
  { id: 'nvidia', displayName: 'Nvidia', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'ollama', displayName: 'Ollama', authMethods: LOCAL_ENDPOINT_AUTH, credentialFields: [apiKeyField(false)], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:52+local', runtimeAdapterId: 'ollama-native' },
  { id: 'ollamacloud', displayName: 'Ollama Cloud', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:11', runtimeAdapterId: 'openai-compatible' },
  { id: 'openai', displayName: 'OpenAI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'streaming', 'structuredOutput', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:46', runtimeAdapterId: 'openai-compatible' },
  { id: 'opencodecodingplan', displayName: 'OpenCode Go', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:15', runtimeAdapterId: 'openai-compatible' },
  { id: 'opencodezen', displayName: 'OpenCode Zen', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:35', runtimeAdapterId: 'openai-compatible' },
  { id: 'openrouter', displayName: 'OpenRouter', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:44', runtimeAdapterId: 'openai-compatible' },
  { id: 'perplexity', displayName: 'Perplexity', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'vision'), modelSourceSpec: 'builtin:6', runtimeAdapterId: 'openai-compatible' },
  { id: 'ppio', displayName: 'PPIO', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'streaming', 'vision'), modelSourceSpec: 'remote+builtin:19', runtimeAdapterId: 'openai-compatible' },
  { id: 'qiniu', displayName: 'Qiniu', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:8', runtimeAdapterId: 'openai-compatible' },
  { id: 'qwen', displayName: 'Aliyun Bailian', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:187', runtimeAdapterId: 'openai-compatible' },
  { id: 'replicate', displayName: 'Replicate', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('imageGeneration'), modelSourceSpec: 'remote+builtin:4', runtimeAdapterId: 'replicate' },
  { id: 'sambanova', displayName: 'SambaNova', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:7', runtimeAdapterId: 'openai-compatible' },
  { id: 'search1api', displayName: 'Search1API', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:4', runtimeAdapterId: 'openai-compatible' },
  { id: 'sensenova', displayName: 'SenseNova', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'siliconcloud', displayName: 'SiliconCloud', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:66', runtimeAdapterId: 'openai-compatible' },
  { id: 'spark', displayName: 'Spark', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:9', runtimeAdapterId: 'openai-compatible' },
  { id: 'stepfun', displayName: 'Stepfun', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:20', runtimeAdapterId: 'openai-compatible' },
  { id: 'straico', displayName: 'Straico', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote', runtimeAdapterId: 'openai-compatible' },
  { id: 'streamlake', displayName: 'StreamLake', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:13', runtimeAdapterId: 'openai-compatible' },
  { id: 'supergrok', displayName: 'SuperGrok', authMethods: OAUTH_DEVICE_CODE_AUTH, credentialFields: oauthTokenFields(), configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'taichu', displayName: 'Taichu', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:13', runtimeAdapterId: 'openai-compatible' },
  { id: 'tencentcloud', displayName: 'TencentCloud', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming'), modelSourceSpec: 'remote+builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'togetherai', displayName: 'Together AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:45', runtimeAdapterId: 'openai-compatible' },
  { id: 'unsloth', displayName: 'Unsloth', authMethods: LOCAL_ENDPOINT_AUTH, credentialFields: [], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:2+local', runtimeAdapterId: 'openai-compatible' },
  { id: 'upstage', displayName: 'Upstage', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'v0', displayName: 'Vercel (v0)', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: EMPTY_CONFIG_FIELDS, capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:3', runtimeAdapterId: 'openai-compatible' },
  { id: 'vercelaigateway', displayName: 'Vercel AI Gateway', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [fetcherField()], capabilities: caps('chat', 'embeddings', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:91', runtimeAdapterId: 'gateway' },
  { id: 'vertexai', displayName: 'Vertex AI', authMethods: VERTEX_AI_AUTH, credentialFields: [apiKeyField(false)], configFields: [projectIdField(), regionField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:28', runtimeAdapterId: 'google-vertex' },
  { id: 'vllm', displayName: 'vLLM', authMethods: LOCAL_ENDPOINT_AUTH, credentialFields: [], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling'), modelSourceSpec: 'remote+builtin:9+local', runtimeAdapterId: 'openai-compatible' },
  { id: 'volcengine', displayName: 'Volcengine', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'structuredOutput', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:33', runtimeAdapterId: 'openai-compatible' },
  { id: 'volcenginecodingplan', displayName: 'Volcengine Coding Plan', authMethods: SUBSCRIPTION_TOKEN_AUTH, credentialFields: [apiKeyField(true, 'Токен плана/подписки')], configFields: [endpointField(), deployNameField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:8', runtimeAdapterId: 'openai-compatible' },
  { id: 'wenxin', displayName: 'Wenxin', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'builtin:52', runtimeAdapterId: 'openai-compatible' },
  { id: 'xai', displayName: 'xAI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:10', runtimeAdapterId: 'openai-compatible' },
  { id: 'xiaomimimo', displayName: 'Xiaomi MiMo', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:5', runtimeAdapterId: 'openai-compatible' },
  { id: 'xinference', displayName: 'Xinference', authMethods: LOCAL_ENDPOINT_AUTH, credentialFields: [], configFields: [endpointField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'builtin:14+local', runtimeAdapterId: 'openai-compatible' },
  { id: 'zenmux', displayName: 'ZenMux', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:69', runtimeAdapterId: 'openai-router' },
  { id: 'zeroone', displayName: '01.AI', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'streaming', 'toolCalling', 'vision'), modelSourceSpec: 'remote+builtin:12', runtimeAdapterId: 'openai-compatible' },
  { id: 'zhipu', displayName: 'ZhiPu', authMethods: API_KEY_AUTH, credentialFields: [apiKeyField()], configFields: [endpointField(), fetcherField()], capabilities: caps('chat', 'imageGeneration', 'streaming', 'toolCalling', 'videoGeneration', 'vision'), modelSourceSpec: 'remote+builtin:51', runtimeAdapterId: 'openai-compatible' },
];

/**
 * Замороженный каталог определений провайдеров (86 записей).
 * Порядок записей — как в enum `ModelProvider` источника.
 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze(
  SEEDS.map(
    (seed): ProviderDefinition => ({
      id: seed.id,
      displayName: seed.displayName,
      category: categoryFor(seed.authMethods, seed.runtimeAdapterId),
      authMethods: seed.authMethods,
      credentialSchema: schema(seed.credentialFields),
      configSchema: configSchema(seed.configFields),
      modelSource: source(seed.modelSourceSpec, seed.modelCountOverride),
      capabilities: seed.capabilities,
      runtimeAdapterId: seed.runtimeAdapterId,
    }),
  ),
);

/** Возвращает копию всех определений каталога. */
export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDER_DEFINITIONS.map((definition) => ({ ...definition }));
}

/** Возвращает определение провайдера или undefined для неизвестного id. */
export function getProvider(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((definition) => definition.id === id);
}

/**
 * Строгая проверка известности провайдера: бросает `PROVIDER_UNKNOWN`
 * для неизвестных id (fail-closed).
 */
export function assertProviderKnown(id: string): void {
  if (!getProvider(id)) {
    throw new Error('PROVIDER_UNKNOWN');
  }
}

/**
 * Безопасная публичная проекция провайдера для Web/API: только идентичность и
 * несекретные метаданные. Совпадает с контрактом
 * `PROVIDER_CATALOG_PROJECTION` из `@ebb-orchestrator/contracts`.
 */
export function toSafeProviderProjection(definition: ProviderDefinition): ProviderCatalogEntryProjection {
  return {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    authMethods: [...definition.authMethods],
    capabilities: [...definition.capabilities],
  };
}

/** Гарантия согласованности серверного каталога и публичной проекции контрактов. */
export const SAFE_PROVIDER_PROJECTION: readonly ProviderCatalogEntryProjection[] = Object.freeze(
  PROVIDER_DEFINITIONS.map((definition) => toSafeProviderProjection(definition)),
);

if (JSON.stringify(SAFE_PROVIDER_PROJECTION) !== JSON.stringify(PROVIDER_CATALOG_PROJECTION)) {
  throw new Error('PROVIDER_CATALOG_PROJECTION_MISMATCH');
}
