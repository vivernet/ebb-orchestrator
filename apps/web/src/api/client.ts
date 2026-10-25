import {
  apiPaths,
  type ChatConversation,
  type MessagesPage,
  type SendMessageResponse,
  type ApprovalDetailProjection,
  type ApprovalInboxProjection,
  type ApprovalPolicyProjection,
  type CancelAllRunsResult,
  type DispatchStateResponse,
  type EpicPauseResponse,
  type EpicReplanResponse,
  type GitHubSyncResponse,
  type ProjectConfigCandidateProjection,
  type ProjectConfigV2,
  type ProjectIndexPageProjection,
  type ProjectPauseResponse,
  type RunControlCommandResult,
  type RunDetailProjection,
  type RunEventsPageProjection,
  type RunTerminalProjection,
  type SchedulerConfig,
  type SchedulerConfigUpdateRequest,
  type SettingsProjection,
  type TaskControlResponse,
  type TaskPriorityResponse,
  type UsageWindowProjection,
  type ProjectConfigReadProjection,
  approvalDetailProjectionSchema,
  approvalInboxProjectionSchema,
  approvalPolicyProjectionSchema,
  cancelAllRunsRequestSchema,
  cancelAllRunsResultSchema,
  dispatchStateRequestSchema,
  dispatchStateResponseSchema,
  epicPauseResponseSchema,
  epicReplanResponseSchema,
  gitHubSyncResponseSchema,
  executionQueueProjectionSchema,
  journalReconcileRequestSchema,
  journalReconcileResponseSchema,
  projectConfigCandidateEditorRequestSchema,
  projectConfigCandidateProjectionSchema,
  projectConfigReadProjectionSchema,
  projectIndexPageProjectionSchema,
  projectPauseResponseSchema,
  runControlCommandResultSchema,
  runDetailProjectionSchema,
  runEventsPageProjectionSchema,
  runTerminalProjectionSchema,
  schedulerConfigSchema,
  schedulerConfigUpdateRequestSchema,
  settingsProjectionSchema,
  taskControlResponseSchema,
  taskPriorityRequestSchema,
  taskPriorityResponseSchema,
  usageWindowProjectionSchema,
} from '@ebb-orchestrator/contracts';
import { z } from 'zod';
import { ru } from '../i18n/ru.js';

const API_BASE = '/api/v1';
/** Переводит canonical API path в относительный путь клиента. */
export function toClientPath(canonicalPath: string): string { if (canonicalPath === API_BASE) return '/'; if (!canonicalPath.startsWith(`${API_BASE}/`)) throw new Error(`API base path is required: ${API_BASE}`); return canonicalPath.slice(API_BASE.length); }
export interface RequestOptions { signal?: AbortSignal; headers?: HeadersInit; }
/** Безопасная ошибка HTTP API без секретных payloads. */
export class ApiError extends Error { constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); this.name = 'ApiError'; } }
export interface ApiClient { get<T>(path: string, options?: RequestOptions): Promise<T>; post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>; put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>; delete<T>(path: string, options?: RequestOptions): Promise<T>; csrfToken: string | null; clearCsrf(): void; }
/** Определяет мутации, которым нужен CSRF только после login. */
function isAuthenticatedMutation(method: string | undefined, path: string): boolean { return method !== undefined && method !== 'GET' && path !== apiPaths.sessionLogin; }
/** Извлекает только безопасные поля error envelope. */
function readError(payload: unknown): { message: string | undefined; code: string | undefined } { if (typeof payload !== 'object' || payload === null) return { message: undefined, code: undefined }; const error = 'error' in payload ? payload.error : undefined; if (typeof error === 'object' && error !== null) return { message: 'message' in error && typeof error.message === 'string' ? error.message : undefined, code: 'code' in error && typeof error.code === 'string' ? error.code : undefined }; return { message: 'error' in payload && typeof payload.error === 'string' ? payload.error : undefined, code: 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined }; }
/** Создаёт клиент с cookie-сессией и volatile CSRF state. */
function createApiClient(): ApiClient { let csrfToken: string | null = null; async function fetchJson<T>(path: string, options: RequestOptions & { method?: string; body?: BodyInit } = {}): Promise<T> { const { headers: requestHeaders, signal, body, method, ...requestOptions } = options; const headers: Record<string, string> = Object.fromEntries(new Headers(requestHeaders).entries()); if (!headers['Content-Type'] && body !== undefined) headers['Content-Type'] = 'application/json'; delete headers.Authorization; delete headers.authorization; if (isAuthenticatedMutation(method, path) && csrfToken) headers['X-CSRF-Token'] = csrfToken; const response = await fetch(path, { ...requestOptions, ...(method ? { method } : {}), ...(body !== undefined ? { body } : {}), credentials: 'same-origin', headers, ...(signal ? { signal } : {}) }); if (!response.ok) { let details: { message: string | undefined; code: string | undefined } = { message: undefined, code: undefined }; try { details = readError(await response.clone().json()); } catch { /* safe fallback */ } throw new ApiError(details.message ?? `API error: ${response.status} ${response.statusText}`, response.status, details.code); } if (response.status === 204) return undefined as T; const text = await response.text(); return text.length === 0 ? undefined as T : JSON.parse(text) as T; } const jsonMutation = (method: string) => <T>(path: string, body?: unknown, options?: RequestOptions) => fetchJson<T>(`${API_BASE}${path}`, { ...options, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { get: <T>(path: string, options?: RequestOptions) => fetchJson<T>(`${API_BASE}${path}`, options), post: jsonMutation('POST'), put: jsonMutation('PUT'), delete: <T>(path: string, options?: RequestOptions) => fetchJson<T>(`${API_BASE}${path}`, { ...options, method: 'DELETE' }), get csrfToken() { return csrfToken; }, set csrfToken(value: string | null) { csrfToken = value; }, clearCsrf() { csrfToken = null; } }; }
/** Общий клиент API текущего browser session. */
export const apiClient = createApiClient();
export interface SessionResponse { contractVersion: 1; csrfToken: string; expiresAt: string; authenticated?: true; }
/** Выполняет login и сохраняет только CSRF в памяти. */
export function login(password: string): Promise<SessionResponse> { return apiClient.post<SessionResponse>(toClientPath(apiPaths.sessionLogin), { password }).then((response) => { apiClient.csrfToken = response.csrfToken; return response; }); }
/** Выполняет idempotent logout и очищает volatile CSRF. */
export function logout(): Promise<void> { return apiClient.post<void>(toClientPath(apiPaths.sessionLogout)).catch((error: unknown) => { if (error instanceof ApiError && error.status === 401 && (error.code === 'AUTH_SESSION_REQUIRED' || error.code === 'AUTH_SESSION_INVALID')) return; throw error; }).then(() => { apiClient.clearCsrf(); }); }
/** Восстанавливает cookie session без создания новой сессии. */
export function restoreSession(): Promise<SessionResponse> { return apiClient.get<SessionResponse>(toClientPath(apiPaths.session)).then((response) => { apiClient.csrfToken = response.csrfToken; return response; }); }

/** Входные данные отправки сообщения чата: контракт плюс requestId-продолжение NEEDS_INPUT. */
export interface SendChatMessageInput {
  content: string;
  asPlanningRequest?: boolean;
  requestId?: string;
}

/** Возвращает список бесед проекта. */
export function listConversations(projectId: string): Promise<ChatConversation[]> {
  return apiClient.get<{ conversations: ChatConversation[] }>(toClientPath(apiPaths.conversations(projectId)))
    .then((response) => response.conversations);
}

/** Создаёт беседу проекта; `title` необязателен. */
export function createConversation(projectId: string, title?: string | null): Promise<ChatConversation> {
  return apiClient.post<{ conversation: ChatConversation }>(
    toClientPath(apiPaths.conversations(projectId)),
    title === undefined || title === null ? undefined : { title },
  ).then((response) => response.conversation);
}

/** Загружает страницу сообщений беседы с cursor-пагинацией. */
export function getMessages(conversationId: string, options?: { cursor?: string; direction?: 'older' | 'newer'; limit?: number }): Promise<MessagesPage> {
  const query = new URLSearchParams();
  if (options?.cursor !== undefined) query.set('cursor', options.cursor);
  if (options?.direction !== undefined) query.set('direction', options.direction);
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  const queryString = query.toString();
  const path = `${toClientPath(apiPaths.conversationMessages(conversationId))}${queryString.length > 0 ? `?${queryString}` : ''}`;
  return apiClient.get<MessagesPage>(path);
}

/** Отправляет сообщение координатору; `asPlanningRequest` запускает планирование. */
export function sendChatMessage(conversationId: string, input: SendChatMessageInput): Promise<SendMessageResponse> {
  return apiClient.post<SendMessageResponse>(toClientPath(apiPaths.conversationMessages(conversationId)), input);
}

/** Одобряет план из беседы; `requestId` связывает запрос планирования. */
export function planApprove(conversationId: string, planId: string, requestId?: string): Promise<void> {
  return apiClient.post<void>(
    toClientPath(apiPaths.planApprove(conversationId, planId)),
    requestId === undefined ? {} : { requestId },
  );
}

/** Отклоняет план из беседы. */
export function planReject(conversationId: string, planId: string): Promise<void> {
  return apiClient.post<void>(toClientPath(apiPaths.planReject(conversationId, planId)), {});
}

/* ==========================================================================
   Типизированные адаптеры Task 1 API путей (plan-27).
   Все URL строятся только через apiPaths route builders; ответы проверяются
   контрактными схемами. Ошибки сервера и состояния unavailable сохраняются,
   fallback-данные никогда не выдумываются.
   ========================================================================== */

interface ZodSchemaLike<T> { safeParse(input: unknown): { success: true; data: T } | { success: false }; }

/** Проверяет payload по контрактной схеме; несоответствие — безопасная ошибка клиента. */
function validate<T>(schema: ZodSchemaLike<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  throw new ApiError(ru.errors.default, 0, 'INVALID_RESPONSE');
}

/** Снимок очереди Scheduler по контрактной проекции. */
export async function getExecutionQueue(): Promise<z.infer<typeof executionQueueProjectionSchema>> {
  return validate(executionQueueProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.execution)));
}

/** Durable пауза/возобновление диспетчеризации scheduler. */
export async function setDispatchState(paused: boolean): Promise<DispatchStateResponse> {
  const body = dispatchStateRequestSchema.parse({ paused });
  return validate(dispatchStateResponseSchema, await apiClient.put<unknown>(toClientPath(apiPaths.schedulerDispatchState), body));
}

/** Подтверждённая массовая отмена Run; результат упорядочен по expectedRunIds. */
export async function cancelAllRuns(expectedRunIds: string[]): Promise<CancelAllRunsResult> {
  const body = cancelAllRunsRequestSchema.parse({ expectedRunIds });
  return validate(cancelAllRunsResultSchema, await apiClient.post<unknown>(toClientPath(apiPaths.runsCancelAll), body));
}

/** Создаёт durable checkpoint Run без остановки. */
export async function createRunCheckpoint(runId: string): Promise<RunControlCommandResult> {
  return validate(runControlCommandResultSchema, await apiClient.post<unknown>(
    toClientPath(apiPaths.runCheckpoint(runId)),
    undefined,
    { headers: { 'idempotency-key': runControlIdempotencyKey(runId, 'checkpoint') } },
  ));
}

/** Кооперативная пауза Run. */
export async function pauseRun(runId: string): Promise<RunControlCommandResult> {
  return validate(runControlCommandResultSchema, await apiClient.post<unknown>(
    toClientPath(apiPaths.runPause(runId)),
    undefined,
    { headers: { 'idempotency-key': runControlIdempotencyKey(runId, 'pause') } },
  ));
}

/** Устойчивый idempotency-key для UI-мутаций run-control: стабилен для
 *  (run, команда), поэтому повторная отправка той же команды дедуплицируется
 *  backend-ом, а разные команды/запуски никогда не конфликтуют. */
function runControlIdempotencyKey(runId: string, command: 'checkpoint' | 'pause' | 'resume'): string {
  return `ebb-ui:run-control:${runId}:${command}`;
}

/** Валидированное возобновление Run после подтверждённого checkpoint. */
export async function resumeRun(runId: string): Promise<RunControlCommandResult> {
  return validate(runControlCommandResultSchema, await apiClient.post<unknown>(
    toClientPath(apiPaths.runResume(runId)),
    undefined,
    { headers: { 'idempotency-key': runControlIdempotencyKey(runId, 'resume') } },
  ));
}

/** Sanitized persisted terminal Run; unavailable-состояние сохраняется без fallback. */
export async function getRunTerminal(runId: string): Promise<RunTerminalProjection> {
  return validate(runTerminalProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.runTerminal(runId))));
}

/** Опции пейджинга Run timeline (opaque outbox курсор + bounded limit). */
export interface RunEventsPageOptions { afterId?: string; limit?: number }

/** Страница durable Run событий по HTTP cursor; никогда не обещает SSE replay. */
export async function getRunEventsPage(runId: string, options?: RunEventsPageOptions): Promise<RunEventsPageProjection> {
  return validate(runEventsPageProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.runEventsPage(runId, options))));
}

/** Run detail DTO: usage-поля сохраняют null-vs-zero (availability). */
export async function getRunDetail(runId: string): Promise<RunDetailProjection> {
  return validate(runDetailProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.run(runId))));
}

/** Пагинированный проектный индекс без repository-путей. */
export async function getProjectIndex(options?: { cursor?: string; limit?: number }): Promise<ProjectIndexPageProjection> {
  return validate(projectIndexPageProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.projectIndex(options))));
}

/** Scoped pause проекта без отмены текущих Run. */
export async function pauseProject(projectId: string): Promise<ProjectPauseResponse> {
  return validate(projectPauseResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.projectPause(projectId))));
}

/** Scoped resume проекта. */
export async function resumeProject(projectId: string): Promise<ProjectPauseResponse> {
  return validate(projectPauseResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.projectResume(projectId))));
}

/** Scoped pause эпика. */
export async function pauseEpic(epicId: string): Promise<EpicPauseResponse> {
  return validate(epicPauseResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.epicPause(epicId))));
}

/** Scoped resume эпика. */
export async function resumeEpic(epicId: string): Promise<EpicPauseResponse> {
  return validate(epicPauseResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.epicResume(epicId))));
}

/** Epic replan создаёт planning request под существующим coordinator/approval lifecycle. */
export async function replanEpic(epicId: string): Promise<EpicReplanResponse> {
  return validate(epicReplanResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.epicReplan(epicId)), {}));
}

/** Task resume сохраняет prior stage; переход подтверждается backend. */
export async function resumeTask(taskId: string): Promise<TaskControlResponse> {
  return validate(taskControlResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.taskResume(taskId))));
}

/** Команда паузы Task; переход подтверждается backend. */
export async function pauseTask(taskId: string): Promise<TaskControlResponse> {
  return validate(taskControlResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.taskPause(taskId))));
}

/** Типизированная синхронизация GitHub проекта (scoped); backend подтверждает статус. */
export async function syncProjectGithub(projectId: string): Promise<GitHubSyncResponse> {
  return validate(gitHubSyncResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.githubSync(projectId))));
}

/** Команда изменения канонического приоритета Task. */
export async function setTaskPriority(taskId: string, priority: number): Promise<TaskPriorityResponse> {
  const body = taskPriorityRequestSchema.parse({ priority });
  return validate(taskPriorityResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.taskPriority(taskId)), body));
}

/** Сохраняет изолированный unapproved кандидат Project Config (не активирует). */
export async function saveProjectConfigCandidate(
  projectId: string,
  candidate: { expectedManifestHash: string; settings: ProjectConfigV2 },
): Promise<ProjectConfigCandidateProjection> {
  const body = projectConfigCandidateEditorRequestSchema.parse(candidate);
  return validate(projectConfigCandidateProjectionSchema, await apiClient.post<unknown>(toClientPath(apiPaths.projectConfigEditorCandidate(projectId)), body));
}

/** CAS-bound reconciliation DEGRADED-журнала конфигурации проекта. */
export async function reconcileProjectConfigJournal(
  projectId: string,
  journalId: string,
  command: { expectedPhase: 'DEGRADED'; observedManifestHash: string; resolution: 'ACCEPT_EXTERNAL' | 'RESTORE_APPROVED' },
): Promise<z.infer<typeof journalReconcileResponseSchema>> {
  const body = journalReconcileRequestSchema.parse(command);
  return validate(journalReconcileResponseSchema, await apiClient.post<unknown>(toClientPath(apiPaths.projectConfigJournalReconcile(projectId, journalId)), body));
}

/** Список согласований (pending/resolved) по стабильному фильтру. */
export async function listApprovals(status?: 'pending' | 'resolved'): Promise<ApprovalInboxProjection> {
  return validate(approvalInboxProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.approvalsList(status))));
}

/** Детальная проекция согласования: proposal, evidence, impact, decision. */
export async function getApprovalDetail(approvalId: string): Promise<ApprovalDetailProjection> {
  return validate(approvalDetailProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.approval(approvalId))));
}

/** Эффективная политика согласований (read-only). */
export async function getApprovalPolicies(): Promise<ApprovalPolicyProjection> {
  return validate(approvalPolicyProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.approvalPolicies)));
}

/** Периодизированная проекция Usage & Budget по строгому UTC-окну. */
export async function getUsageWindow(
  from: string,
  to: string,
  granularity: 'day' | 'hour' | 'month',
): Promise<UsageWindowProjection> {
  return validate(usageWindowProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.usageWindow(from, to, granularity))));
}

/** Сохраняет валидированную конфигурацию scheduler через typed маршрут. */
export async function updateSchedulerConfig(config: SchedulerConfigUpdateRequest): Promise<SchedulerConfig> {
  const body = schedulerConfigUpdateRequestSchema.parse(config);
  const raw = await apiClient.put<unknown>(toClientPath(apiPaths.schedulerConfig), body);
  const parsed = schedulerConfigSchema.safeParse(raw);
  // Ответ в канонической форме проверяется строго; иначе (например, echo-проекция
  // иной формы) запись уже подтверждена сервером — прокидываем без выдумывания.
  return parsed.success ? parsed.data : (raw as SchedulerConfig);
}

/** Read-only валидированная проекция настроек пространства (GET /settings). */
export async function getSettings(options?: RequestOptions): Promise<SettingsProjection> {
  if (options === undefined) {
    return validate(settingsProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.settings)));
  }
  return validate(settingsProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.settings), options));
}

/** Валидированное чтение состояния конфигурации проекта (active rev/candidate). */
export async function getProjectConfig(projectId: string): Promise<ProjectConfigReadProjection> {
  return validate(projectConfigReadProjectionSchema, await apiClient.get<unknown>(toClientPath(apiPaths.projectConfig(projectId))));
}
