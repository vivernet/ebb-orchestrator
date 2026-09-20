import { describe, expect, test, vi, afterEach } from 'vitest';
import { router } from '../src/app/router.js';
import { apiClient, bootstrap, restoreSession } from '../src/api/client.js';

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

  test('exchanges the launch token for an in-memory session exactly once', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sessionToken: 'memory-session', csrfToken: 'memory-csrf', origin: 'http://127.0.0.1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await bootstrap('one-time-launch-token');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/bootstrap', expect.objectContaining({
      headers: expect.objectContaining({ 'X-EBB-Bootstrap-Token': 'one-time-launch-token' }),
    }));
    expect(apiClient.sessionToken).toBe('memory-session');
    expect(apiClient.csrfToken).toBe('memory-csrf');
  });

  test('restores a reload-safe local session without exposing a bearer token to JavaScript', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      csrfToken: 'restored-csrf', origin: 'http://127.0.0.1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await restoreSession();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(apiClient.sessionToken).toBeNull();
    expect(apiClient.csrfToken).toBe('restored-csrf');
  });
});
