/**
 * Управление провайдерами для Task 6: пользовательские модели, список моделей,
 * обновление модельного каталога из API провайдера и проверка соединения.
 *
 * Инварианты:
 *  - сетевые вызовы выполняются ТОЛЬКО через `ProviderNetworkGateway`
 *    (egress-шлюз) с ограниченным таймаутом; результаты наружу возвращаются
 *    только типизированные безопасные коды, без тел ответов и без URL;
 *  - значения секретов не покидают вызовов: заголовки собираются в Buffer и
 *    обнуляются после запроса;
 *  - неизвестный провайдер/модель завершаются fail-closed;
 *  - пользовательские модели валидируются по каталогу (провайдер существует)
 *    и по формату model_id.
 */

import type { Database } from "../../../platform/database/database.js";
import { getProvider, assertProviderKnown } from "./provider-catalog.js";
import { PROVIDER_ADAPTER_REGISTRY } from "./adapters/registry.js";
import { ProviderNetworkGateway, ProviderGatewayError } from "./provider-network-gateway.js";
import type { ProviderCredentialStore } from "./provider-credential-store.js";
import type { ProviderModelEntry } from "./provider-types.js";
import { getModelsForProvider } from "./provider-model-catalog.js";
import type { ProviderModelsProjection, ProviderConnectionTestProjection } from "@ebb-orchestrator/contracts";

/** Максимальное число пользовательских моделей на провайдера. */
export const MAX_CUSTOM_MODELS_PER_PROVIDER = 200;

/** Допустимый формат идентификатора модели (без пробелов и управляющих символов). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Ошибка валидации пользовательской модели. */
export class InvalidCustomModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidCustomModelError";
  }
}

/** Запись пользовательской модели провайдера. */
export interface ProviderCustomModelRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly createdAt: string;
}

/** Контракт репозитория пользовательских моделей. */
export interface ProviderCustomModelsRepository {
  listCustomModels(providerId: string): ProviderCustomModelRecord[];
  addCustomModel(input: { providerId: string; modelId: string; displayName?: string }): ProviderCustomModelRecord;
  removeCustomModel(providerId: string, modelId: string): boolean;
}

type CustomModelRow = {
  provider_id: string;
  model_id: string;
  display_name: string;
  created_at: string;
};

function toCustomModelRecord(row: CustomModelRow): ProviderCustomModelRecord {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/** SQLite-адаптер репозитория пользовательских моделей. */
export class SqliteProviderCustomModelsRepository implements ProviderCustomModelsRepository {
  public constructor(private readonly database: Database) {}

  listCustomModels(providerId: string): ProviderCustomModelRecord[] {
    const rows = this.database.all<CustomModelRow>(
      "SELECT provider_id, model_id, display_name, created_at FROM provider_custom_models WHERE provider_id = $providerId ORDER BY model_id",
      { providerId },
    );
    return rows.map(toCustomModelRecord);
  }

  addCustomModel(input: { providerId: string; modelId: string; displayName?: string }): ProviderCustomModelRecord {
    assertProviderKnown(input.providerId);
    if (!MODEL_ID_PATTERN.test(input.modelId)) {
      throw new InvalidCustomModelError("Model id must match [A-Za-z0-9._:-]{1,128}");
    }
    const displayName = (input.displayName ?? "").trim();
    if (displayName.length > 200) {
      throw new InvalidCustomModelError("Model display name exceeds 200 characters");
    }
    if (this.listCustomModels(input.providerId).length >= MAX_CUSTOM_MODELS_PER_PROVIDER) {
      throw new InvalidCustomModelError(`Custom model limit reached: ${MAX_CUSTOM_MODELS_PER_PROVIDER}`);
    }
    const now = new Date().toISOString();
    try {
      this.database.run(
        "INSERT INTO provider_custom_models(provider_id, model_id, display_name, created_at) VALUES($providerId, $modelId, $displayName, $now)",
        { providerId: input.providerId, modelId: input.modelId, displayName, now },
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) {
        throw new InvalidCustomModelError(`Custom model '${input.modelId}' already exists for provider '${input.providerId}'`);
      }
      throw error;
    }
    const row = this.database.get<CustomModelRow>(
      "SELECT provider_id, model_id, display_name, created_at FROM provider_custom_models WHERE provider_id = $providerId AND model_id = $modelId",
      { providerId: input.providerId, modelId: input.modelId },
    );
    if (!row) throw new Error("Custom model insert returned no row");
    return toCustomModelRecord(row);
  }

  removeCustomModel(providerId: string, modelId: string): boolean {
    this.database.run(
      "DELETE FROM provider_custom_models WHERE provider_id = $providerId AND model_id = $modelId",
      { providerId, modelId },
    );
    const row = this.database.get<{ changes: number }>("SELECT changes() AS changes");
    return Number(row?.changes ?? 0) > 0;
  }
}

/** Создаёт SQLite-репозиторий пользовательских моделей. */
export function createProviderCustomModelsRepository(database: Database): ProviderCustomModelsRepository {
  return new SqliteProviderCustomModelsRepository(database);
}

function toEntryProjection(entry: ProviderModelEntry, origin: "catalog" | "custom" | "api") {
  return {
    modelId: entry.modelId,
    displayName: entry.displayName,
    type: entry.type,
    capabilities: [...entry.capabilities],
    contextWindowTokens: entry.contextWindowTokens ?? null,
    maxOutput: entry.maxOutput ?? null,
    origin,
  };
}

/**
 * Возвращает безопасную проекцию списка моделей провайдера: статичный каталог
 * + пользовательские модели. Для неизвестного провайдера — fail-closed.
 */
export function listProviderModels(
  repository: ProviderCustomModelsRepository,
  providerId: string,
): ProviderModelsProjection {
  assertProviderKnown(providerId);
  const catalog = getModelsForProvider(providerId).map((entry) => toEntryProjection(entry, "catalog"));
  const custom = repository.listCustomModels(providerId).map((record) => toEntryProjection({
    providerId,
    modelId: record.modelId,
    displayName: record.displayName.length > 0 ? record.displayName : record.modelId,
    type: "chat",
    capabilities: [],
  }, "custom"));
  return {
    providerId,
    source: "catalog",
    refreshedAt: null,
    entries: [...catalog, ...custom],
  };
}

/** Схема auth-заголовка для refresh/проверки по методу (без значений). */
function authHeaderForMethod(authMethodId: string, credentialPayload: Readonly<Record<string, string>>): Record<string, string> | null {
  if (authMethodId === "api-key" || authMethodId === "subscription-token") {
    const token = credentialPayload.apiKey ?? credentialPayload.token ?? credentialPayload.subscriptionToken;
    if (typeof token === "string" && token.length > 0) return { authorization: `Bearer ${token}` };
    return null;
  }
  return null;
}

/** Парсит OpenAI-совместимый ответ /models в безопасные записи (без сырых тел). */
function parseOpenAIModelsResponse(body: string, providerId: string): ProviderModelEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("MODELS_PARSE_FAILED");
  }
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed) || !Array.isArray((parsed as { data: unknown }).data)) {
    throw new Error("MODELS_PARSE_FAILED");
  }
  const entries: ProviderModelEntry[] = [];
  for (const item of (parsed as { data: unknown[] }).data) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const modelId = record.id;
    if (typeof modelId !== "string" || !MODEL_ID_PATTERN.test(modelId)) continue;
    entries.push({
      providerId,
      modelId,
      displayName: typeof record.display_name === "string" && record.display_name.length > 0 ? record.display_name : modelId,
      type: "chat",
      capabilities: [],
    });
  }
  return entries;
}

/** Зависимости сетевых операций провайдеров (Task 6). */
export interface ProviderManagementNetworkDeps {
  readonly gateway?: ProviderNetworkGateway;
  readonly credentialStore?: ProviderCredentialStore;
  readonly requestTimeoutMs?: number;
}

/** Таймаут проверки соединения (мс), ограниченный сверху. */
export const CONNECTION_TEST_TIMEOUT_MS = 8000;

/** Таймаут refresh модельного каталога (мс). */
export const MODELS_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Проверяет соединение с провайдером через шлюз: GET на базовый endpoint
 * (дефолтный или заданный конфигурацией) с ограниченным таймаутом.
 * Наружу возвращаются только статус, длительность и типизированный код ошибки —
 * без тела ответа, URL и секретов.
 */
export async function testProviderConnection(
  deps: ProviderManagementNetworkDeps,
  providerId: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Promise<ProviderConnectionTestProjection> {
  const definition = getProvider(providerId);
  if (!definition) throw new Error("PROVIDER_UNKNOWN");
  if (!deps.gateway) {
    return { providerId, ok: false, status: null, durationMs: 0, errorKind: "unavailable" };
  }

  let endpointUrl: string;
  let isLocalEndpoint: boolean;
  try {
    const endpoint = PROVIDER_ADAPTER_REGISTRY.resolveEndpoint(providerId, config);
    endpointUrl = endpoint.baseUrl;
    isLocalEndpoint = endpoint.isLocalEndpoint;
    if (endpointUrl.length === 0) throw new Error("EMPTY_ENDPOINT");
  } catch {
    return { providerId, ok: false, status: null, durationMs: 0, errorKind: "unavailable" };
  }

  const declaresLocalEndpointSupport = definition.authMethods.includes("local-endpoint");

  const startedAt = Date.now();
  try {
    const response = await deps.gateway!.execute({
      method: "GET",
      url: endpointUrl,
      headers: {},
      allowPrivateDestination: declaresLocalEndpointSupport && isLocalEndpoint,
      timeoutMs: deps.requestTimeoutMs ?? CONNECTION_TEST_TIMEOUT_MS,
      sizeLimitBytes: 64 * 1024,
    });
    return {
      providerId,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      durationMs: response.durationMs,
      errorKind: response.status >= 200 && response.status < 400 ? null : "http-status",
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (error instanceof ProviderGatewayError) {
      switch (error.kind) {
        case "timeout": return { providerId, ok: false, status: null, durationMs, errorKind: "timeout" };
        case "forbidden-destination": return { providerId, ok: false, status: null, durationMs, errorKind: "forbidden-destination" };
        case "dns-resolution-failed": return { providerId, ok: false, status: null, durationMs, errorKind: "dns-resolution-failed" };
        case "malformed-url": return { providerId, ok: false, status: null, durationMs, errorKind: "unavailable" };
        default: return { providerId, ok: false, status: null, durationMs, errorKind: "transport" };
      }
    }
    return { providerId, ok: false, status: null, durationMs, errorKind: "transport" };
  }
}

/**
 * Обновляет модельный список провайдера из его API (OpenAI-совместимый
 * `GET {endpoint}/models`) через шлюз. Использует конфигурацию провайдера
 * и (при наличии) credential для сортировки заголовка. Возвращает безопасный
 * список без секретов; ошибки типизированы.
 */
export async function refreshProviderModelsFromApi(
  deps: ProviderManagementNetworkDeps,
  providerId: string,
  config: Readonly<Record<string, unknown>> | undefined,
  selectedAuthMethod?: string,
): Promise<ProviderModelsProjection> {
  const definition = getProvider(providerId);
  if (!definition) throw new Error("PROVIDER_UNKNOWN");
  if (!deps.gateway) throw new Error("MODELS_API_UNAVAILABLE");
  if (!definition.modelSource.providerCatalog) {
    throw new Error("MODELS_API_UNAVAILABLE");
  }

  let endpointUrl: string;
  let isLocalEndpoint: boolean;
  try {
    const endpoint = PROVIDER_ADAPTER_REGISTRY.resolveEndpoint(providerId, config);
    endpointUrl = endpoint.baseUrl;
    isLocalEndpoint = endpoint.isLocalEndpoint;
    if (endpointUrl.length === 0) throw new Error("EMPTY_ENDPOINT");
  } catch {
    throw new Error("MODELS_API_ENDPOINT_MISSING");
  }
  const modelsUrl = `${endpointUrl.replace(/\/+$/, "")}/models`;
  const declaresLocalEndpointSupport = definition.authMethods.includes("local-endpoint");

  let headers: Record<string, string> = {};
  if (deps.credentialStore && selectedAuthMethod) {
    try {
      headers = authHeaderForMethod(selectedAuthMethod, await deps.credentialStore.readCredentialPayload(providerId, selectedAuthMethod)) ?? {};
    } catch {
      // Без credentials запрос выполняется без заголовка auth; 401 → 'auth-required'.
      headers = {};
    }
  }

  try {
    const response = await deps.gateway!.execute({
      method: "GET",
      url: modelsUrl,
      headers,
      allowPrivateDestination: declaresLocalEndpointSupport && isLocalEndpoint,
      timeoutMs: deps.requestTimeoutMs ?? MODELS_REFRESH_TIMEOUT_MS,
      sizeLimitBytes: 1024 * 1024,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("MODELS_API_AUTH_REQUIRED");
    }
    if (response.status >= 400) {
      throw new Error("MODELS_API_HTTP_STATUS");
    }
    const entries = parseOpenAIModelsResponse(response.body, providerId);
    return {
      providerId,
      source: "api",
      refreshedAt: new Date().toISOString(),
      entries: entries.map((entry) => toEntryProjection(entry, "api")),
    };
  } catch (error) {
    if (error instanceof Error && (error.message === "MODELS_API_AUTH_REQUIRED" || error.message === "MODELS_API_HTTP_STATUS" || error.message === "MODELS_PARSE_FAILED")) {
      throw error;
    }
    if (error instanceof ProviderGatewayError) {
      switch (error.kind) {
        case "timeout": throw new Error("MODELS_API_TIMEOUT", { cause: error });
        case "forbidden-destination": throw new Error("MODELS_API_FORBIDDEN_DESTINATION", { cause: error });
        case "dns-resolution-failed": throw new Error("MODELS_API_DNS_FAILED", { cause: error });
        default: throw new Error("MODELS_API_TRANSPORT", { cause: error });
      }
    }
    throw error;
  }
}
