/**
 * Authenticated HTTP client for the orchestrator API.
 * Maintains local session token in memory (never localStorage).
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
    const response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiClient.sessionToken ? { Authorization: `Bearer ${apiClient.sessionToken}` } : {}),
        ...(apiClient.csrfToken ? { 'X-CSRF-Token': apiClient.csrfToken } : {}),
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      let serverMessage: string | null = null;
      try {
        const payload: unknown = await response.clone().json();
        if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
          serverMessage = payload.error;
        }
      } catch {
        // Non-JSON error responses use the safe status fallback below.
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

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export function bootstrap(): Promise<void> {
  return apiClient.get<{ sessionToken: string; csrfToken: string }>('/session/bootstrap').then(({ sessionToken, csrfToken }) => {
    apiClient.sessionToken = sessionToken;
    apiClient.csrfToken = csrfToken;
  });
}
