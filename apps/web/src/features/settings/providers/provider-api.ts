/**
 * Клиентский API-слой страниц провайдеров (plan-24, Task 6).
 *
 * Все запросы идут через общий apiClient (cookie-сессия + CSRF). Типы ответов
 * — безопасные проекции из `@ebb-orchestrator/contracts`; секретов/endpoint
 * значений/credential-ссылок клиент никогда не получает.
 */

import {
  apiPaths,
  type ProviderCatalogProjection,
  type ProviderDetailProjection,
  type ProviderSettingsProjection,
  type ProviderModelsProjection,
  type ProviderConnectionTestProjection,
} from '@ebb-orchestrator/contracts';
import { apiClient, toClientPath } from '../../../api/client.js';

export interface ProviderAuthFlowProjection {
  flowId: string;
  providerId: string;
  methodId: string;
  status: 'PENDING' | 'COMPLETE' | 'CANCELLED' | 'EXPIRED';
  expiresAt: string;
  pollIntervalSeconds: number;
  verificationUrl?: string;
  userCode?: string;
  errorKind?: string;
}

export interface ProviderAuthStatusProjection {
  providerId: string;
  methodId: string;
  hasCredential: boolean;
  credentialStatus: 'ACTIVE' | 'DISCONNECTED' | 'NONE';
  activeFlows: ProviderAuthFlowProjection[];
  latestFlow?: ProviderAuthFlowProjection;
}

export interface ProviderBeginAuthResult {
  flowId: string;
  verificationUrl?: string;
  userCode?: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

export interface ProviderDisconnectResult {
  providerId: string;
  localDisconnected: true;
  remoteRevoke: 'NOT_ATTEMPTED' | 'LOCAL_DISCONNECTED';
  revokedCredentialRefs: string[];
}

/** Полная безопасная проекция каталога (86 записей). */
export function getProviderCatalog(): Promise<ProviderCatalogProjection> {
  return apiClient.get<ProviderCatalogProjection>(toClientPath(apiPaths.providerCatalog));
}

/** Статусные проекции всех настроенных провайдеров (без секретов). */
export function getProviderStatuses(): Promise<{ providers: ProviderSettingsProjection[] }> {
  return apiClient.get<{ providers: ProviderSettingsProjection[] }>(toClientPath(apiPaths.providerStatuses));
}

/** Детальная безопасная проекция провайдера (schema + статус). */
export function getProviderDetail(providerId: string): Promise<ProviderDetailProjection> {
  return apiClient.get<ProviderDetailProjection>(toClientPath(apiPaths.provider(providerId)));
}

/** Статусная проекция одного провайдера. */
export function getProviderStatus(providerId: string): Promise<ProviderSettingsProjection> {
  return apiClient.get<ProviderSettingsProjection>(toClientPath(apiPaths.provider(providerId)) + '/status');
}

export interface SaveProviderConfigInput {
  enabled?: boolean;
  selectedAuthMethod?: string;
  config?: Record<string, string | number | boolean | null>;
  modelSelection?: { defaultModelId: string | null; roleDefaults: Record<string, string> };
}

/** Сохраняет несекретные настройки провайдера (merge-семантика). */
export function saveProviderConfig(providerId: string, input: SaveProviderConfigInput): Promise<ProviderSettingsProjection> {
  return apiClient.put<ProviderSettingsProjection>(toClientPath(apiPaths.providerConfig(providerId)), input);
}

/** Сохраняет/заменяет credential провайдера; значения не возвращаются. */
export function saveProviderCredential(providerId: string, authMethodId: string, fields: Record<string, string>): Promise<{
  providerId: string;
  authMethodId: string;
  status: 'ACTIVE';
  hasCredential: true;
  createdAt: string;
  updatedAt: string;
}> {
  return apiClient.put(toClientPath(apiPaths.providerCredential(providerId)), { authMethodId, fields });
}

/** Удаляет локальный credential провайдера. */
export function deleteProviderCredential(providerId: string, authMethodId: string): Promise<void> {
  return apiClient.delete<void>(toClientPath(apiPaths.providerCredential(providerId)) + `?authMethodId=${encodeURIComponent(authMethodId)}`).then(() => undefined);
}

/** Запускает проверку соединения с провайдером. */
export function testProviderConnection(providerId: string): Promise<ProviderConnectionTestProjection> {
  return apiClient.post<ProviderConnectionTestProjection>(toClientPath(apiPaths.providerTestConnection(providerId)), {});
}

/** Возвращает модельный список провайдера (каталог + custom). */
export function getProviderModels(providerId: string): Promise<ProviderModelsProjection> {
  return apiClient.get<ProviderModelsProjection>(toClientPath(apiPaths.providerModels(providerId)));
}

/** Обновляет модельный список из API провайдера. */
export function refreshProviderModels(providerId: string): Promise<ProviderModelsProjection> {
  return apiClient.post<ProviderModelsProjection>(toClientPath(apiPaths.providerModelsRefresh(providerId)), {});
}

/** Добавляет пользовательскую модель провайдера. */
export function addCustomModel(providerId: string, modelId: string, displayName?: string): Promise<{ providerId: string; modelId: string; displayName: string; createdAt: string }> {
  return apiClient.post(toClientPath(apiPaths.providerCustomModels(providerId)), { modelId, ...(displayName ? { displayName } : {}) });
}

/** Удаляет пользовательскую модель провайдера. */
export function removeCustomModel(providerId: string, modelId: string): Promise<void> {
  return apiClient.delete<void>(toClientPath(apiPaths.providerCustomModel(providerId, modelId))).then(() => undefined);
}

/** Запускает интерактивный поток авторизации. */
export function startProviderAuthFlow(providerId: string, methodId: string): Promise<ProviderBeginAuthResult> {
  return apiClient.post<ProviderBeginAuthResult>(toClientPath(apiPaths.providerAuthStart), { providerId, methodId });
}

/** Возвращает безопасную проекцию потока авторизации. */
export function getProviderAuthFlow(flowId: string): Promise<ProviderAuthFlowProjection> {
  return apiClient.get<ProviderAuthFlowProjection>(toClientPath(apiPaths.providerAuthFlow(flowId)));
}

/** Опрашивает поток авторизации. */
export function pollProviderAuthFlow(flowId: string): Promise<ProviderAuthFlowProjection> {
  return apiClient.post<ProviderAuthFlowProjection>(toClientPath(apiPaths.providerAuthPoll(flowId)), {});
}

/** Отменяет поток авторизации. */
export function cancelProviderAuthFlow(flowId: string): Promise<void> {
  return apiClient.post<void>(toClientPath(apiPaths.providerAuthCancel(flowId)), {}).then(() => undefined);
}

/** Отключает провайдера (локальные credentials удаляются). */
export function disconnectProvider(providerId: string): Promise<ProviderDisconnectResult> {
  return apiClient.post<ProviderDisconnectResult>(toClientPath(apiPaths.providerAuthDisconnect), { providerId });
}

/** Статус авторизации провайдера (без секретов). */
export function getProviderAuthStatus(providerId: string): Promise<ProviderAuthStatusProjection> {
  return apiClient.get<ProviderAuthStatusProjection>(toClientPath(apiPaths.providerAuthStatus(providerId)));
}
