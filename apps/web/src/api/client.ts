/**
 * Аутентифицированный HTTP-клиент API оркестратора.
 * Bootstrap bearer хранится только в памяти; после перезагрузки браузер
 * использует HttpOnly-cookie локальной сессии и восстанавливает в памяти
 * только CSRF-токен.
 */

const API_BASE = '/api/v1';

interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  sessionToken: string | null;
  csrfToken: string | null;
}

function createApiClient(): ApiClient {
  async function fetchJson<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const { headers: requestHeaders, ...requestOptions } = options;
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(apiClient.sessionToken ? { Authorization: `Bearer ${apiClient.sessionToken}` } : {}),
        ...(apiClient.csrfToken ? { 'X-CSRF-Token': apiClient.csrfToken } : {}),
        ...requestHeaders,
      },
      ...requestOptions,
    });

    if (!response.ok) {
      let serverMessage: string | null = null;
      try {
        const payload: unknown = await response.clone().json();
        if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
          serverMessage = payload.error;
        }
      } catch {
        // Для не-JSON ответа используем безопасное сообщение со статусом ниже.
      }
      throw new Error(serverMessage ?? `API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  return {
    sessionToken: null as string | null,
    csrfToken: null as string | null,

    async get<T>(path: string): Promise<T> {
      return fetchJson<T>(`${API_BASE}${path}`);
    },

    async post<T>(path: string, body?: unknown): Promise<T> {
      return fetchJson<T>(`${API_BASE}${path}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : null,
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
  if (!launchToken) return Promise.reject(new Error('A one-time local launch token is required.'));
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
