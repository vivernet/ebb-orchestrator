import { describe, expect, test, vi, afterEach } from 'vitest';
import { router } from '../src/app/router.js';
import { apiClient, bootstrap } from '../src/api/client.js';

describe('routing and session bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.sessionToken = null;
    apiClient.csrfToken = null;
  });

  test('uses stable IDs for core projection routes', () => {
    const routes = router.routes[0]?.children ?? [];
    expect(routes.slice(0, 4).map((route) => route.id)).toEqual([
      'dashboard', 'project', 'epic', 'task',
    ]);
  });

  test('bootstraps from the server session endpoint and retains CSRF in memory', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sessionToken: 'memory-session', csrfToken: 'memory-csrf', origin: 'http://127.0.0.1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await bootstrap();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/bootstrap', expect.anything());
    expect(apiClient.sessionToken).toBe('memory-session');
    expect(apiClient.csrfToken).toBe('memory-csrf');
  });
});
