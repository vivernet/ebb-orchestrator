/**
 * API adapter для запусков агентов (runs).
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, contextManifestProjectionSchema, contextManifestSubjectSchema, type ContextManifestProjection, type ContextManifestSubjectProjection, type EventProjection } from '@ebb-orchestrator/contracts';

/** Безопасные metadata артефакта, привязанного backend к конкретному Run. */
export interface RunArtifactMetadata {
  id: string;
  type: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  status: string;
  createdAt: string;
}

/** Будущий или повреждённый ответ манифеста: UI показывает его как unknown без сырых полей. */
export interface UnknownRunContextManifest {
  availability: 'unknown';
  runId: string;
  subject: ContextManifestSubjectProjection | null;
  role: string;
}

export type RunContextManifest = ContextManifestProjection | UnknownRunContextManifest;

/** Проверяет safe API projection без размещения wire discriminant в UI source. */
export function isUnavailableRunContextManifest(
  manifest: RunContextManifest | null,
): manifest is Extract<RunContextManifest, { availability: 'unavailable' }> {
  return manifest?.availability === 'unavailable';
}

/** Загружает только metadata артефактов Run; endpoint никогда не возвращает содержимое. */
export async function getRunArtifacts(id: string): Promise<RunArtifactMetadata[]> {
  return apiClient.get<RunArtifactMetadata[]>(toClientPath(`${apiPaths.run(id)}/artifacts`));
}

/** Загружает safe provenance конкретного Run; неизвестный ответ остаётся явным unknown. */
export async function getRunContextManifests(id: string): Promise<RunContextManifest> {
  const raw = await apiClient.get<unknown>(toClientPath(`${apiPaths.run(id)}/context-manifests`));
  const parsed = contextManifestProjectionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const subjectCandidate = isRecord(raw) ? contextManifestSubjectSchema.safeParse(raw.subject) : null;
  const roleCandidate = isRecord(raw) ? raw.role : null;
  const allowedRoles = ['coordinator', 'product_manager', 'architect', 'developer', 'reviewer', 'qa', 'integration'] as const;
  const role = typeof roleCandidate === 'string' && allowedRoles.some((candidate) => candidate === roleCandidate)
    ? roleCandidate
    : 'unknown';
  return {
    availability: 'unknown',
    runId: isRecord(raw) && typeof raw.runId === 'string' && raw.runId.trim() !== '' ? raw.runId : id,
    subject: subjectCandidate?.success ? subjectCandidate.data : null,
    role,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
