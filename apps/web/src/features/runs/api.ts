/**
 * API adapter для запусков агентов (runs).
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, type EventProjection } from '@ebb-orchestrator/contracts';

/**
 * Событие для показа в истории запуска.
 */
export interface RunEvent extends EventProjection {
  aggregateType: string;
  aggregateId: string;
  availableAt: string;
  processedAt: string | null;
  attempts: number;
}

/**
 * События запуска агента.
 */
export async function getRunEvents(id: string): Promise<RunEvent[]> {
  const response = await apiClient.get<RunEvent[]>(
    toClientPath(apiPaths.runEvents(id)),
  );
  return response;
}

/**
 * Инструменты, разрешённые для запуска.
 */
export interface RunToolsResponse {
  runId: string;
  tools: string[];
}

/**
 * Инструменты для указанного запуска.
 */
export async function getRunTools(id: string): Promise<RunToolsResponse> {
  const response = await apiClient.get<RunToolsResponse>(
    toClientPath(apiPaths.runTools(id)),
  );
  return response;
}

/**
 * Запись аудита (permissions/audit log) для запуска.
 */
export interface AuditLogEntry {
  id: string;
  action: string;
  actor: string;
  aggregateType: string;
  aggregateId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * Записи аудита для указанного запуска.
 */
export async function getRunPermissions(id: string): Promise<AuditLogEntry[]> {
  const response = await apiClient.get<AuditLogEntry[]>(
    toClientPath(apiPaths.runPermissions(id)),
  );
  return response;
}

/**
 * Попытка восстановления.
 */
export interface RecoveryAttempt {
  id: string;
  roleLevel: string;
  failureType: string;
  attemptCount: number;
  timestamp: string;
  fingerprint: Record<string, unknown> | null;
}

/**
 * Запрос восстановления планировщика.
 */
export interface RecoverySchedulerRequest {
  id: string;
  roleLevel: string;
  failureType: string;
  attemptCount: number;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Состояние восстановления.
 */
export interface RecoveryState {
  id: string;
  status: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Данные восстановления для запуска.
 */
export interface RunRecoveryResponse {
  runId: string;
  taskId: string | null;
  runStatus: string;
  recovery: {
    attempts: RecoveryAttempt[];
    schedulerRequests: RecoverySchedulerRequest[];
    state: RecoveryState | null;
  } | null;
}

/**
 * Данные восстановления для указанного запуска.
 */
export async function getRunRecovery(id: string): Promise<RunRecoveryResponse> {
  const response = await apiClient.get<RunRecoveryResponse>(
    toClientPath(apiPaths.runRecovery(id)),
  );
  return response;
}
