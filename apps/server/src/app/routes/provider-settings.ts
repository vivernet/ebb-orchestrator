/**
 * Маршруты настроек AI-провайдеров (plan-24, Task 6).
 *
 * Все маршруты живут под защитой глобального auth/CSRF-хука createApp:
 * GET — аутентифицированная сессия, изменяющие методы — Origin + CSRF.
 *
 * Проекции НИКОГДА не содержат значений credentials, endpoint URL и ссылок на
 * credential-записи: только статусные булевы значения и метаданные. Настройки
 * сохраняются merge-семантикой: отсутствующие поля сохраняют текущее значение,
 * `null` в config-значении удаляет ключ (без эха сохранённых значений).
 */

import type { FastifyInstance } from "fastify";
import {
  PROVIDER_CATALOG_CONTRACT_VERSION,
  PROVIDER_CATALOG_PROJECTION,
  type ProviderCatalogProjection,
  type ProviderDetailProjection,
  type ProviderSchemaFieldProjection,
  type ProviderSettingsProjection,
} from "@ebb-orchestrator/contracts";
import { getProvider, PROVIDER_CATALOG_SOURCE_PIN, PROVIDER_CATALOG_VERSION } from "../../modules/runtime/providers/provider-catalog.js";
import type { ProviderAuthMethod, ConfigFieldDefinition, CredentialFieldDefinition } from "../../modules/runtime/providers/provider-types.js";
import type { ProviderSettingsService } from "../../modules/runtime/providers/provider-settings-service.js";
import {
  InvalidProviderConfigurationError,
  ProviderConfigurationMissingError,
} from "../../modules/runtime/providers/provider-settings-repository.js";
import { ProviderCredentialStoreUnavailableError } from "../../modules/runtime/providers/provider-credential-store.js";
import { isSecretStoreUnavailableError } from "../../platform/security/secret-store.js";
import type { ProviderNetworkGateway } from "../../modules/runtime/providers/provider-network-gateway.js";
import {
  testProviderConnection,
} from "../../modules/runtime/providers/provider-management.js";

/** Зависимости маршрутов настроек провайдеров. */
export interface ProviderSettingsRouteDeps {
  readonly service?: ProviderSettingsService;
  readonly gateway?: ProviderNetworkGateway;
}

/** Типизированный ответ ошибки: код + русское сообщение без деталей сети. */
interface ProviderErrorEnvelope {
  error: { code: string; message: string };
}

const MESSAGES: Record<string, string> = {
  PROVIDER_UNKNOWN: "Провайдер не найден.",
  AUTH_METHOD_UNKNOWN: "Метод аутентификации неизвестен.",
  PROVIDER_CONFIG_INVALID: "Конфигурация провайдера некорректна.",
  PROVIDER_CONFIG_MISSING: "Конфигурация провайдера не найдена.",
  PROVIDER_CREDENTIAL_STORE_UNAVAILABLE: "Хранилище учётных данных временно недоступно.",
  PROVIDER_CREDENTIAL_INVALID: "Данные учётной записи некорректны.",
  PROVIDER_TEST_CONNECTION_UNAVAILABLE: "Проверка соединения временно недоступна.",
};

function errorEnvelope(code: string): ProviderErrorEnvelope {
  return { error: { code, message: MESSAGES[code] ?? "Не удалось выполнить запрос." } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Валидирует несекретную конфигурацию: плоский объект, ограниченный размер. */
function normalizeConfigPayload(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).length > 32) return null;
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key.length === 0 || key.length > 64) return null;
    if (fieldValue === null) {
      result[key] = null; // маркер удаления ключа
      continue;
    }
    if (typeof fieldValue === "string") {
      if (fieldValue.length > 4096) return null;
      result[key] = fieldValue;
    } else if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      result[key] = fieldValue;
    } else if (typeof fieldValue === "boolean") {
      result[key] = fieldValue;
    } else {
      return null;
    }
  }
  return result;
}

/** Валидирует modelSelection: defaultModelId (string|null) + roleDefaults (Record<string,string>). */
function normalizeModelSelectionPayload(value: unknown): { defaultModelId: string | null; roleDefaults: Record<string, string> } | null {
  if (!isPlainRecord(value)) return null;
  const defaultModelId = value.defaultModelId;
  if (defaultModelId !== null && defaultModelId !== undefined && typeof defaultModelId !== "string") return null;
  const roleDefaults = value.roleDefaults;
  if (roleDefaults === undefined) return null;
  if (!isPlainRecord(roleDefaults)) return null;
  const normalized: Record<string, string> = {};
  for (const [role, modelId] of Object.entries(roleDefaults)) {
    if (role.length === 0 || role.length > 64) return null;
    if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 128) return null;
    normalized[role] = modelId;
  }
  return {
    defaultModelId: defaultModelId === undefined ? null : defaultModelId,
    roleDefaults: normalized,
  };
}

/** Маппинг auth-метода на тип Web-формы. */
function authMethodKind(method: ProviderAuthMethod): "form" | "interactive" | "ambient" | "endpoint" {
  switch (method) {
    case "api-key":
    case "subscription-token":
    case "credential-fields":
      return "form";
    case "oauth-device-code":
    case "oauth-pkce":
      return "interactive";
    case "cloud-identity":
      return "ambient";
    case "local-endpoint":
      return "endpoint";
  }
}

function configFieldProjection(field: ConfigFieldDefinition): ProviderSchemaFieldProjection {
  return { name: field.name, label: field.label, kind: field.kind, required: field.required };
}

function credentialFieldProjection(field: CredentialFieldDefinition): ProviderSchemaFieldProjection {
  return {
    name: field.name,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.managedByAuthFlow ? { managedByAuthFlow: true } : {}),
  };
}

function detailProjection(providerId: string, status?: ProviderSettingsProjection): ProviderDetailProjection | null {
  const definition = getProvider(providerId);
  if (!definition) return null;
  const authMethodKinds = Object.fromEntries(definition.authMethods.map((method) => [method, authMethodKind(method)])) as ProviderDetailProjection["authMethodKinds"];
  return {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    authMethods: [...definition.authMethods],
    capabilities: [...definition.capabilities],
    authMethodKinds,
    configFields: definition.configSchema.fields.map(configFieldProjection),
    credentialFields: definition.credentialSchema.fields.map(credentialFieldProjection),
    modelSource: {
      kind: definition.modelSource.kind,
      providerCatalog: definition.modelSource.providerCatalog,
      userCustom: definition.modelSource.userCustom,
      localEndpoint: definition.modelSource.localEndpoint,
      modelCount: definition.modelSource.modelCount,
    },
    ...(status ? { status } : {}),
  };
}

function safeSettingsProjection(status: {
  providerId: string;
  enabled: boolean;
  selectedAuthMethod: string;
  currentRevision: number;
  hasCredential: boolean;
  credentialStatus: "ACTIVE" | "DISCONNECTED" | "NONE";
  defaultModelId: string | null;
  roleDefaults: Readonly<Record<string, string>>;
  createdAt: string;
  updatedAt: string;
}): ProviderSettingsProjection {
  return {
    providerId: status.providerId,
    enabled: status.enabled,
    selectedAuthMethod: status.selectedAuthMethod,
    currentRevision: status.currentRevision,
    hasCredential: status.hasCredential,
    credentialStatus: status.credentialStatus,
    defaultModelId: status.defaultModelId,
    roleDefaults: { ...status.roleDefaults },
    createdAt: status.createdAt,
    updatedAt: status.updatedAt,
  };
}

function statusFor(error: unknown): { code: number; kind: string } {
  if (error instanceof InvalidProviderConfigurationError) return { code: 400, kind: "PROVIDER_CONFIG_INVALID" };
  if (error instanceof ProviderConfigurationMissingError) return { code: 404, kind: "PROVIDER_CONFIG_MISSING" };
  if (error instanceof ProviderCredentialStoreUnavailableError) return { code: 503, kind: "PROVIDER_CREDENTIAL_STORE_UNAVAILABLE" };
  if (isSecretStoreUnavailableError(error)) return { code: 503, kind: "PROVIDER_CREDENTIAL_STORE_UNAVAILABLE" };
  if (error instanceof Error && error.message.startsWith("PROVIDER_UNKNOWN")) return { code: 404, kind: "PROVIDER_UNKNOWN" };
  if (error instanceof Error && error.message.startsWith("AUTH_METHOD_UNKNOWN")) return { code: 400, kind: "AUTH_METHOD_UNKNOWN" };
  return { code: 502, kind: "PROVIDER_UNAVAILABLE" };
}

/**
 * Регистрирует маршруты настроек провайдеров. Отсутствующие зависимости
 * отвечают 503 (composition-зависимость), каталог доступен всегда.
 */
export async function providerSettingsRoutes(app: FastifyInstance, deps: ProviderSettingsRouteDeps = {}): Promise<void> {
  const service = deps.service;
  const gateway = deps.gateway;

  app.get("/api/v1/providers/catalog", async (): Promise<ProviderCatalogProjection> => ({
    contractVersion: PROVIDER_CATALOG_CONTRACT_VERSION,
    version: PROVIDER_CATALOG_VERSION,
    sourcePin: PROVIDER_CATALOG_SOURCE_PIN,
    providers: PROVIDER_CATALOG_PROJECTION,
  }));

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request, reply) => {
    const status = service?.getProviderStatus(request.params.providerId);
    const detail = detailProjection(request.params.providerId, status ? safeSettingsProjection(status) : undefined);
    if (!detail) return reply.code(404).send(errorEnvelope("PROVIDER_UNKNOWN"));
    return detail;
  });

  app.get("/api/v1/providers/status", async () => {
    if (!service) return { providers: [] };
    return { providers: service.listProviderStatuses().map(safeSettingsProjection) };
  });

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/status", async (request, reply) => {
    if (!service) return reply.code(503).send(errorEnvelope("PROVIDER_UNAVAILABLE"));
    const status = service.getProviderStatus(request.params.providerId);
    if (!status) return reply.code(404).send(errorEnvelope("PROVIDER_CONFIG_MISSING"));
    return safeSettingsProjection(status);
  });

  app.put<{ Params: { providerId: string }; Body: unknown }>("/api/v1/providers/:providerId/config", async (request, reply) => {
    if (!service) return reply.code(503).send(errorEnvelope("PROVIDER_UNAVAILABLE"));
    const body = request.body;
    if (!isPlainRecord(body)) return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));
    const allowed = new Set(["enabled", "selectedAuthMethod", "config", "modelSelection", "save"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));
    if (body.selectedAuthMethod !== undefined && (typeof body.selectedAuthMethod !== "string" || body.selectedAuthMethod.length === 0)) {
      return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));
    }
    const existing = service.getSettings(request.params.providerId);
    const configPayload = body.config === undefined ? undefined : normalizeConfigPayload(body.config);
    if (body.config !== undefined && configPayload === null) return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));

    // Merge-семантика: отсутствующие ключи сохраняют текущее значение; null удаляет ключ.
    let mergedConfig: Record<string, unknown> | undefined;
    if (configPayload !== undefined && configPayload !== null) {
      mergedConfig = { ...(existing?.config ?? {}) };
      for (const [key, value] of Object.entries(configPayload)) {
        if (value === null) delete mergedConfig[key];
        else mergedConfig[key] = value;
      }
    }

    const modelSelectionPayload = body.modelSelection === undefined ? undefined : normalizeModelSelectionPayload(body.modelSelection);
    if (body.modelSelection !== undefined && modelSelectionPayload === null) return reply.code(400).send(errorEnvelope("PROVIDER_CONFIG_INVALID"));
    const modelSelectionInput = modelSelectionPayload === null ? undefined : modelSelectionPayload;

    try {
      const saved = service.saveSettings({
        providerId: request.params.providerId,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(typeof body.selectedAuthMethod === "string" ? { selectedAuthMethod: body.selectedAuthMethod } : {}),
        ...(mergedConfig !== undefined ? { config: mergedConfig } : {}),
        ...(modelSelectionInput !== undefined ? { modelSelection: modelSelectionInput } : {}),
      });
      const status = service.getProviderStatus(saved.providerId);
      if (!status) return reply.code(502).send(errorEnvelope("PROVIDER_UNAVAILABLE"));
      return safeSettingsProjection(status);
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(errorEnvelope(kind));
    }
  });

  app.put<{ Params: { providerId: string }; Body: unknown }>("/api/v1/providers/:providerId/credential", async (request, reply) => {
    if (!service) return reply.code(503).send(errorEnvelope("PROVIDER_UNAVAILABLE"));
    const body = request.body;
    if (!isPlainRecord(body)) return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
    const authMethodId = body.authMethodId;
    if (typeof authMethodId !== "string" || authMethodId.length === 0) {
      return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
    }
    const fields = body.fields;
    if (!isPlainRecord(fields)) return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
    const payload: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string") return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
      if (value.length > 8192) return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
      payload[key] = value;
    }
    try {
      const result = await service.saveCredential(request.params.providerId, authMethodId, payload);
      return {
        providerId: result.providerId,
        authMethodId: result.authMethodId,
        status: result.status,
        hasCredential: true,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(errorEnvelope(kind));
    }
  });

  app.delete<{ Params: { providerId: string }; Querystring: { authMethodId?: string }; Body: unknown }>("/api/v1/providers/:providerId/credential", async (request, reply) => {
    const queryMethod = request.query.authMethodId;
    const body = request.body;
    const authMethodId = typeof queryMethod === "string" && queryMethod.length > 0
      ? queryMethod
      : isPlainRecord(body) && typeof body.authMethodId === "string"
        ? body.authMethodId
        : undefined;
    if (!authMethodId) {
      return reply.code(400).send(errorEnvelope("PROVIDER_CREDENTIAL_INVALID"));
    }
    if (!service) return reply.code(503).send(errorEnvelope("PROVIDER_UNAVAILABLE"));
    try {
      const removed = await service.deleteCredential(request.params.providerId, authMethodId);
      return reply.code(removed ? 204 : 404).send();
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(errorEnvelope(kind));
    }
  });

  app.post<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/test-connection", async (request, reply) => {
    if (!gateway) return reply.code(503).send(errorEnvelope("PROVIDER_TEST_CONNECTION_UNAVAILABLE"));
    const config = service?.getSettings(request.params.providerId)?.config;
    try {
      return await testProviderConnection({ gateway }, request.params.providerId, config);
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(errorEnvelope(kind));
    }
  });
}
