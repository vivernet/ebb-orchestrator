/**
 * Аутентифицированный HTTP-клиент API оркестратора.
 * Bootstrap bearer хранится только в памяти; после перезагрузки браузер
 * использует HttpOnly-cookie локальной сессии и восстанавливает в памяти
 * только CSRF-токен.
 */

const API_BASE = '/api/v1';

/**
 * Переводит canonical API path из shared contracts в relative path клиента.
 * Префикс проверяется здесь, чтобы страницы не дублировали знание о base path.
 */
export function toClientPath(canonicalPath: string): string {
  if (canonicalPath === API_BASE) return '/';
  if (!canonicalPath.startsWith(`${API_BASE}/`)) {
    throw new Error(`API base path is required: ${API_BASE}`);
  }
  return canonicalPath.slice(API_BASE.length);
}

interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  sessionToken: string | null;
  csrfToken: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
}

/**
 * Представляет безопасную ошибку API с HTTP status и optional machine-readable code.
 * Не содержит bearer, CSRF, launch token или сырые секретные payloads.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function createApiClient(): ApiClient {
  async function fetchJson<T>(
    path: string,
    options: RequestOptions & { method?: string; body?: BodyInit | null | undefined } = {},
  ): Promise<T> {
    const { headers: requestHeaders, signal, body, ...requestOptions } = options;
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...requestHeaders,
        ...(apiClient.sessionToken ? { Authorization: `Bearer ${apiClient.sessionToken}` } : {}),
        ...(apiClient.csrfToken ? { 'X-CSRF-Token': apiClient.csrfToken } : {}),
      },
      ...(signal ? { signal } : {}),
      ...(body !== undefined ? { body } : {}),
      ...requestOptions,
    });

    if (!response.ok) {
      let serverMessage: string | null = null;
      let serverCode: string | undefined;
      try {
        const payload: unknown = await response.clone().json();
        if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
          serverMessage = payload.error;
        }
        if (typeof payload === 'object' && payload !== null && 'code' in payload && typeof payload.code === 'string') {
          serverCode = payload.code;
        }
      } catch {
        // Для не-JSON ответа используем безопасное сообщение со статусом ниже.
      }
      throw new ApiError(serverMessage ?? `API error: ${response.status} ${response.statusText}`, response.status, serverCode);
    }

    if (response.status === 204) return undefined as T;
    const responseText = await response.text();
    return responseText.length === 0 ? undefined as T : JSON.parse(responseText) as T;
  }

  return {
    sessionToken: null as string | null,
    csrfToken: null as string | null,

    async get<T>(path: string, options?: RequestOptions): Promise<T> {
      return fetchJson<T>(`${API_BASE}${path}`, options);
    },

    async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return fetchJson<T>(`${API_BASE}${path}`, {
        ...options,
        method: 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}

export const apiClient = createApiClient();

/** Возвращает bearer-заголовок для потокового API, если bootstrap ещё хранит его в памяти. */
export function authenticatedHeaders(): Record<string, string> {
  return apiClient.sessionToken ? { Authorization: `Bearer ${apiClient.sessionToken}` } : {};
}

/**
 * Выполняет bootstrap локальной сессии через одноразовый launch token.
 */
export function bootstrap(launchToken: string): Promise<void> {
  if (!launchToken) return Promise.reject(new Error('Требуется одноразовый токен локального запуска.'));
  return fetch('/api/v1/session/bootstrap', {
    credentials: 'same-origin',
    headers: { 'X-EBB-Bootstrap-Token': launchToken },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Local session bootstrap failed: ${response.status}`);
    return response.json() as Promise<{ sessionToken: string; csrfToken: string }>;
  }).then(({ sessionToken, csrfToken }) => {
    apiClient.sessionToken = sessionToken;
    apiClient.csrfToken = csrfToken;
  });
}

/**
 * Восстанавливает CSRF-состояние после reload через HttpOnly-cookie локальной сессии.
 * Bearer-токен намеренно не возвращается и не сохраняется в JavaScript storage.
 */
export function restoreSession(): Promise<void> {
  return fetch('/api/v1/session', { credentials: 'same-origin' }).then(async (response) => {
    if (!response.ok) throw new Error(`Local session restore failed: ${response.status}`);
    return response.json() as Promise<{ csrfToken: string }>;
  }).then(({ csrfToken }) => {
    apiClient.sessionToken = null;
    apiClient.csrfToken = csrfToken;
  });
}
