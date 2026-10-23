/**
 * Реестр адаптеров провайдеров (plan-24, Task 3).
 *
 * Строит для каждого из 86 provider ID каталога конкретную ссылку на
 * конфигурацию адаптера (семейство протокола, auth-схема, chatPath,
 * endpoint-правила, способности, фабрика). Гарантия: каждый ID разрешается
 * в конкретный адаптер (86/86), без «тихого» скрытия неподдерживаемых
 * провайдеров.
 *
 * Дефолтные базовые URL заданы только для провайдеров без endpoint-поля
 * конфигурации (значения — публичные API базовые URL, не секреты).
 * Всё остальное endpoint задаётся пользовательской конфигурацией.
 */

import { getProvider, PROVIDER_DEFINITIONS } from "../provider-catalog.js";
import { ProviderRuntimeError } from "../provider-error-mapper.js";
import type {
  ProviderAdapterConfigReference,
  ProviderAuthScheme,
  ProviderChatAdapter,
  ProviderProtocolFamily,
  ProviderToolArgumentSchema,
  ResolvedProviderEndpoint,
} from "../provider-runtime-port.js";
import { resolveProviderEndpoint } from "../provider-request.js";
import { createAnthropicCompatibleAdapter } from "./anthropic-adapter.js";
import { createAzureAIInferenceAdapter } from "./azure-ai-inference-adapter.js";
import { createAzureOpenAIAdapter } from "./azure-openai-adapter.js";
import { createCloudIdentityAdapter } from "./cloud-identity-adapter.js";
import { createCloudflareWorkersAIAdapter } from "./cloudflare-workers-ai-adapter.js";
import { createGoogleGenerativeAdapter } from "./google-generative-adapter.js";
import { createHuggingFaceInferenceAdapter } from "./huggingface-inference-adapter.js";
import { createImageCapabilityAdapter } from "./image-capability-adapter.js";
import { createLobeHubAdapter } from "./lobehub-adapter.js";
import { createOAuthDeviceAdapter } from "./oauth-device-adapter.js";
import { createOllamaNativeAdapter } from "./ollama-native-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

/** Маппинг runtimeAdapterId каталога на семейство протокола. */
const FAMILY_BY_RUNTIME_ADAPTER_ID: Readonly<Record<string, ProviderProtocolFamily>> = {
  "openai-compatible": "openai-compatible",
  "openai-router": "openai-compatible",
  "anthropic-compatible": "anthropic-compatible",
  "azure-openai": "azure-openai",
  "azure-ai-inference": "azure-ai-inference",
  "image-rest": "image-rest",
  "image-video-rest": "image-video-rest",
  replicate: "replicate",
  comfyui: "comfyui",
  "ollama-native": "ollama-native",
  "cloudflare-workers-ai": "cloudflare-workers-ai",
  "huggingface-inference": "huggingface-inference",
  "google-generative": "google-generative",
  "aws-bedrock": "aws-bedrock",
  "google-vertex": "google-vertex",
  "platform-cloud": "platform-cloud",
  gateway: "gateway",
};

/** Публичные базовые URL для провайдеров без endpoint-поля конфигурации. */
const DEFAULT_BASE_URL_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  ai21: "https://api.ai21.com/studio/v1",
  antgroup: "https://api.ant-ling.com/v1",
  spark: "https://spark-api-open.xf-yun.com/v1",
  v0: "https://api.v0.dev/v1",
  ai360: "https://api.360.cn/v1",
  akashchat: "https://chatapi.akash.network/api/v1",
  ollamacloud: "https://ollama.com/v1",
  ppio: "https://api.ppinfra.com/v3/openai",
  vercelaigateway: "https://ai-gateway.vercel.sh/v1",
  lobehub: "https://api.chat.lobehub.org/v1",
};

/** Провайдеры, чей провод управляется OAuth/device-flow (Task 4). */
const OAUTH_DEVICE_PROVIDERS: ReadonlySet<string> = new Set(["chatgpt", "githubcopilot", "supergrok"]);

/** Image-only провайдеры и их семейства. */
const IMAGE_CAPABILITY_PROVIDERS: Readonly<Record<string, ProviderProtocolFamily>> = {
  bfl: "image-rest",
  fal: "image-video-rest",
  replicate: "replicate",
  comfyui: "comfyui",
};

/** Cloud-identity провайдеры (скелетон до настройки identity). */
const CLOUD_IDENTITY_PROVIDERS: Readonly<Record<string, ProviderProtocolFamily>> = {
  bedrock: "aws-bedrock",
  vertexai: "google-vertex",
};

const AZURE_DEFAULT_API_VERSION = "2024-06-01";

function authSchemeFor(authMethods: readonly string[]): ProviderAuthScheme {
  if (authMethods.includes("oauth-device-code")) return { kind: "bearer" };
  if (authMethods.includes("subscription-token")) return { kind: "bearer" };
  if (authMethods.includes("api-key")) return { kind: "bearer" };
  if (authMethods.includes("local-endpoint")) return { kind: "none" };
  if (authMethods.includes("credential-fields")) return { kind: "none" };
  if (authMethods.includes("cloud-identity")) return { kind: "none" };
  return { kind: "none" };
}

function hasEndpointConfigField(configFields: readonly { name: string; kind: string }[]): boolean {
  return configFields.some((field) => field.kind === "endpoint");
}

function chatPathFor(family: ProviderProtocolFamily): string {
  switch (family) {
    case "anthropic-compatible":
      return "/v1/messages";
    case "ollama-native":
      return "/api/chat";
    case "google-generative":
      return "";
    case "azure-ai-inference":
      return "/models/chat/completions";
    default:
      return "/chat/completions";
  }
}

function resolveAzureEndpoint(config: Readonly<Record<string, unknown>> | undefined): ResolvedProviderEndpoint {
  const resourceName = typeof config?.resourceName === "string" ? (config.resourceName as string).trim() : "";
  const deploymentName = typeof config?.deploymentName === "string" ? (config.deploymentName as string).trim() : "";
  if (resourceName.length === 0 || deploymentName.length === 0) {
    throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", "azure-resource-deployment");
  }
  return {
    baseUrl: `https://${resourceName}.openai.azure.com/openai/deployments/${deploymentName}`,
    isLocalEndpoint: false,
  };
}

function resolveCloudflareEndpoint(config: Readonly<Record<string, unknown>> | undefined): ResolvedProviderEndpoint {
  const accountId = typeof config?.accountId === "string" ? (config.accountId as string).trim() : "";
  if (accountId.length === 0) {
    throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", "cloudflare-account-id");
  }
  return {
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    isLocalEndpoint: false,
  };
}

function createAdapterFor(providerId: string, family: ProviderProtocolFamily, authMethods: readonly string[]): () => ProviderChatAdapter {
  const cloudIdentity = CLOUD_IDENTITY_PROVIDERS[providerId];
  if (cloudIdentity) {
    return () => createCloudIdentityAdapter({ providerId, family: cloudIdentity });
  }
  const imageCapability = IMAGE_CAPABILITY_PROVIDERS[providerId];
  if (imageCapability) {
    return () => createImageCapabilityAdapter({ providerId, family: imageCapability, capability: "image" });
  }
  switch (family) {
    case "anthropic-compatible":
      return () => createAnthropicCompatibleAdapter({ providerId, auth: authSchemeFor(authMethods) });
    case "ollama-native":
      return () => createOllamaNativeAdapter({ providerId, auth: authSchemeFor(authMethods) });
    case "google-generative":
      return () => createGoogleGenerativeAdapter({ providerId, auth: authSchemeFor(authMethods) });
    case "azure-openai":
      return () => createAzureOpenAIAdapter({ providerId });
    case "azure-ai-inference":
      return () => createAzureAIInferenceAdapter({ providerId });
    case "cloudflare-workers-ai":
      return () => createCloudflareWorkersAIAdapter({ providerId });
    case "huggingface-inference":
      return () => createHuggingFaceInferenceAdapter({ providerId });
    case "platform-cloud":
      return () => createLobeHubAdapter({ providerId });
    default:
      if (OAUTH_DEVICE_PROVIDERS.has(providerId)) {
        return () => createOAuthDeviceAdapter({ providerId });
      }
      return () => createOpenAICompatibleAdapter({
        providerId,
        family,
        auth: authSchemeFor(authMethods),
      });
  }
}

function buildReference(providerId: string): ProviderAdapterConfigReference {
  const definition = getProvider(providerId);
  if (!definition) throw new Error("PROVIDER_UNKNOWN");
  const family = FAMILY_BY_RUNTIME_ADAPTER_ID[definition.runtimeAdapterId];
  if (!family) {
    throw new Error(`PROVIDER_ADAPTER_FAMILY_UNKNOWN:${providerId}`);
  }
  const auth = authSchemeFor(definition.authMethods);
  const requiresEndpointConfig = hasEndpointConfigField(definition.configSchema.fields);
  const capabilities = [...definition.capabilities];
  const supportsStreaming = capabilities.includes("streaming") && !IMAGE_CAPABILITY_PROVIDERS[providerId] && !CLOUD_IDENTITY_PROVIDERS[providerId];
  const supportsToolCalls = capabilities.includes("toolCalling") && !IMAGE_CAPABILITY_PROVIDERS[providerId] && !CLOUD_IDENTITY_PROVIDERS[providerId];

  let resolveEndpoint: ProviderAdapterConfigReference["resolveEndpoint"];
  let endpointQuery: ProviderAdapterConfigReference["endpointQuery"];

  if (providerId === "azure") {
    resolveEndpoint = resolveAzureEndpoint;
    endpointQuery = (config) => {
      const apiVersion = typeof config?.apiVersion === "string" && (config.apiVersion as string).trim().length > 0
        ? (config.apiVersion as string).trim()
        : AZURE_DEFAULT_API_VERSION;
      return { "api-version": apiVersion };
    };
  } else if (providerId === "cloudflare") {
    resolveEndpoint = resolveCloudflareEndpoint;
  }

  return {
    providerId,
    family,
    auth,
    chatPath: chatPathFor(family),
    ...(DEFAULT_BASE_URL_BY_PROVIDER[providerId] !== undefined
      ? { defaultBaseUrl: DEFAULT_BASE_URL_BY_PROVIDER[providerId] }
      : {}),
    requiresEndpointConfig,
    ...(resolveEndpoint ? { resolveEndpoint } : {}),
    ...(endpointQuery ? { endpointQuery } : {}),
    supportsStreaming,
    supportsToolCalls,
    capabilities,
    create: createAdapterFor(providerId, family, definition.authMethods),
  };
}

/** Реестр адаптеров: стабильное разрешение providerId → ссылка/адаптер. */
export class ProviderAdapterRegistry {
  private readonly references: ReadonlyMap<string, ProviderAdapterConfigReference>;

  public constructor(definitions: readonly { id: string }[] = PROVIDER_DEFINITIONS) {
    const map = new Map<string, ProviderAdapterConfigReference>();
    for (const definition of definitions) {
      map.set(definition.id, buildReference(definition.id));
    }
    this.references = map;
  }

  /** Возвращает ссылку на конфигурацию адаптера или undefined. */
  public get(providerId: string): ProviderAdapterConfigReference | undefined {
    return this.references.get(providerId);
  }

  /** Все ссылки (86 штук). */
  public list(): readonly ProviderAdapterConfigReference[] {
    return [...this.references.values()];
  }

  /** Создаёт экземпляр адаптера для провайдера (fail-closed). */
  public createAdapter(providerId: string): ProviderChatAdapter {
    const reference = this.references.get(providerId);
    if (!reference) throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", `unknown-provider:${providerId}`);
    return reference.create();
  }

  /** Разрешает endpoint для запроса (кастомное правило или стандартное). */
  public resolveEndpoint(
    providerId: string,
    config: Readonly<Record<string, unknown>> | undefined,
  ): ResolvedProviderEndpoint {
    const reference = this.references.get(providerId);
    if (!reference) throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", `unknown-provider:${providerId}`);
    if (reference.resolveEndpoint) return reference.resolveEndpoint(config);
    return resolveProviderEndpoint(reference, config);
  }

  /** Query-параметры endpoint для запроса. */
  public endpointQuery(providerId: string, config: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, string>> {
    const reference = this.references.get(providerId);
    if (!reference?.endpointQuery) return {};
    return reference.endpointQuery(config);
  }
}

/** Единственный экземпляр реестра поверх замороженного каталога (86/86). */
export const PROVIDER_ADAPTER_REGISTRY = new ProviderAdapterRegistry();

/** Проверяет, что провайдер поддерживает чат (для рунтайма). */
export function providerSupportsChat(providerId: string): boolean {
  const definition = getProvider(providerId);
  if (!definition) return false;
  return definition.capabilities.includes("chat") && definition.runtimeAdapterId !== "platform-cloud";
}

/** Схема параметров инструмента по умолчанию (object). */
export function emptyToolSchema(): ProviderToolArgumentSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}
