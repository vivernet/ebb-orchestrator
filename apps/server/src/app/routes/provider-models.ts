/**
 * Маршруты модельного каталога провайдеров (plan-24, Task 6).
 *
 * Модельный список объединяет статичный каталог Ebb и пользовательские модели.
 * Refresh списка выполняется ТОЛЬКО через egress-шлюз с ограниченным таймаутом;
 * ответы API провайдеров наружу не возвращаются — только безопасные записи.
 * Значения credentials не покидают вызовов (заголовки собираются и обнуляются
 * внутри provider-management).
 */

import type { FastifyInstance } from "fastify";
import type { ProviderCustomModelsRepository } from "../../modules/runtime/providers/provider-management.js";
import {
  InvalidCustomModelError,
  listProviderModels,
  refreshProviderModelsFromApi,
  type ProviderManagementNetworkDeps,
} from "../../modules/runtime/providers/provider-management.js";
import { assertProviderKnown } from "../../modules/runtime/providers/provider-catalog.js";
import type { ProviderSettingsService } from "../../modules/runtime/providers/provider-settings-service.js";
import { InvalidProviderConfigurationError } from "../../modules/runtime/providers/provider-settings-repository.js";
import { ProviderCredentialStoreUnavailableError } from "../../modules/runtime/providers/provider-credential-store.js";
import { isSecretStoreUnavailableError } from "../../platform/security/secret-store.js";

/** Зависимости маршрутов моделей провайдеров. */
export interface ProviderModelsRouteDeps extends ProviderManagementNetworkDeps {
  readonly service?: ProviderSettingsService;
  readonly customModels?: ProviderCustomModelsRepository;
}

/** Валидирует входные данные добавления пользовательской модели. */
function parseCustomModelBody(value: unknown): { modelId: string; displayName?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== "string" || record.modelId.length === 0) return null;
  if (record.displayName !== undefined && typeof record.displayName !== "string") return null;
  return {
    modelId: record.modelId,
    ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
  };
}

function statusFor(error: unknown): { code: number; kind: string } {
  if (error instanceof InvalidCustomModelError) return { code: 400, kind: "PROVIDER_MODEL_INVALID" };
  if (error instanceof InvalidProviderConfigurationError) return { code: 400, kind: "PROVIDER_CONFIG_INVALID" };
  if (error instanceof ProviderCredentialStoreUnavailableError) return { code: 503, kind: "PROVIDER_CREDENTIAL_STORE_UNAVAILABLE" };
  if (isSecretStoreUnavailableError(error)) return { code: 503, kind: "PROVIDER_CREDENTIAL_STORE_UNAVAILABLE" };
  if (error instanceof Error && error.message.startsWith("PROVIDER_UNKNOWN")) return { code: 404, kind: "PROVIDER_UNKNOWN" };
  if (error instanceof Error) {
    switch (error.message) {
      case "MODELS_API_UNAVAILABLE": return { code: 400, kind: "PROVIDER_MODELS_API_UNAVAILABLE" };
      case "MODELS_API_ENDPOINT_MISSING": return { code: 400, kind: "PROVIDER_MODELS_ENDPOINT_MISSING" };
      case "MODELS_API_AUTH_REQUIRED": return { code: 401, kind: "PROVIDER_MODELS_AUTH_REQUIRED" };
      case "MODELS_API_HTTP_STATUS": return { code: 502, kind: "PROVIDER_MODELS_HTTP_STATUS" };
      case "MODELS_PARSE_FAILED": return { code: 502, kind: "PROVIDER_MODELS_PARSE_FAILED" };
      case "MODELS_API_TIMEOUT": return { code: 504, kind: "PROVIDER_MODELS_TIMEOUT" };
      case "MODELS_API_FORBIDDEN_DESTINATION": return { code: 502, kind: "PROVIDER_MODELS_FORBIDDEN_DESTINATION" };
      case "MODELS_API_DNS_FAILED": return { code: 502, kind: "PROVIDER_MODELS_DNS_FAILED" };
      case "MODELS_API_TRANSPORT": return { code: 502, kind: "PROVIDER_MODELS_TRANSPORT" };
    }
  }
  return { code: 502, kind: "PROVIDER_MODELS_UNAVAILABLE" };
}

function envelope(kind: string): { error: { code: string; message: string } } {
  const messages: Record<string, string> = {
    PROVIDER_UNKNOWN: "Провайдер не найден.",
    PROVIDER_MODEL_INVALID: "Модель некорректна.",
    PROVIDER_CONFIG_INVALID: "Конфигурация провайдера некорректна.",
    PROVIDER_CREDENTIAL_STORE_UNAVAILABLE: "Хранилище учётных данных временно недоступно.",
    PROVIDER_MODELS_API_UNAVAILABLE: "Провайдер не поддерживает загрузку списка моделей из API.",
    PROVIDER_MODELS_ENDPOINT_MISSING: "Endpoint для загрузки списка моделей не настроен.",
    PROVIDER_MODELS_AUTH_REQUIRED: "Для загрузки списка моделей требуется аутентификация.",
    PROVIDER_MODELS_HTTP_STATUS: "Сервис провайдера вернул ошибку.",
    PROVIDER_MODELS_PARSE_FAILED: "Не удалось разобрать список моделей провайдера.",
    PROVIDER_MODELS_TIMEOUT: "Истекло время ожидания ответа провайдера.",
    PROVIDER_MODELS_FORBIDDEN_DESTINATION: "Назначение endpoint запрещено политикой сети.",
    PROVIDER_MODELS_DNS_FAILED: "Не удалось разрешить адрес endpoint.",
    PROVIDER_MODELS_TRANSPORT: "Ошибка соединения с провайдером.",
    PROVIDER_MODELS_UNAVAILABLE: "Список моделей временно недоступен.",
  };
  return { error: { code: kind, message: messages[kind] ?? "Не удалось выполнить запрос." } };
}

/**
 * Регистрирует маршруты модельного каталога провайдеров.
 */
export async function providerModelsRoutes(app: FastifyInstance, deps: ProviderModelsRouteDeps = {}): Promise<void> {
  const customModels = deps.customModels;
  const gateway = deps.gateway;

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/models", async (request, reply) => {
    try {
      assertProviderKnown(request.params.providerId);
      if (!customModels) return reply.code(503).send(envelope("PROVIDER_MODELS_UNAVAILABLE"));
      return listProviderModels(customModels, request.params.providerId);
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(envelope(kind));
    }
  });

  app.post<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/models/refresh", async (request, reply) => {
    if (!gateway) return reply.code(503).send(envelope("PROVIDER_MODELS_UNAVAILABLE"));
    try {
      const config = deps.service?.getSettings(request.params.providerId)?.config;
      const selectedAuthMethod = deps.service?.getSettings(request.params.providerId)?.selectedAuthMethod;
      const networkDeps = {
        gateway,
        ...(deps.credentialStore ? { credentialStore: deps.credentialStore } : {}),
      };
      return await refreshProviderModelsFromApi(networkDeps, request.params.providerId, config, selectedAuthMethod);
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(envelope(kind));
    }
  });

  app.post<{ Params: { providerId: string }; Body: unknown }>("/api/v1/providers/:providerId/models/custom", async (request, reply) => {
    if (!customModels) return reply.code(503).send(envelope("PROVIDER_MODELS_UNAVAILABLE"));
    const input = parseCustomModelBody(request.body);
    if (!input) return reply.code(400).send(envelope("PROVIDER_MODEL_INVALID"));
    try {
      assertProviderKnown(request.params.providerId);
      const record = customModels.addCustomModel({ providerId: request.params.providerId, ...input });
      return reply.code(201).send({
        providerId: record.providerId,
        modelId: record.modelId,
        displayName: record.displayName,
        createdAt: record.createdAt,
      });
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(envelope(kind));
    }
  });

  app.delete<{ Params: { providerId: string; modelId: string } }>("/api/v1/providers/:providerId/models/custom/:modelId", async (request, reply) => {
    if (!customModels) return reply.code(503).send(envelope("PROVIDER_MODELS_UNAVAILABLE"));
    try {
      const removed = customModels.removeCustomModel(request.params.providerId, request.params.modelId);
      return reply.code(removed ? 204 : 404).send();
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send(envelope(kind));
    }
  });
}
