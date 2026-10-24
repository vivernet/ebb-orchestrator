import { apiPaths, type ChatConversation, type MessagesPage, type SendMessageResponse } from '@ebb-orchestrator/contracts';

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
