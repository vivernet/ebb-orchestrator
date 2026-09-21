import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiClient, ApiError, toClientPath } from '../src/api/client.js';
import { apiPaths } from '@ebb-orchestrator/contracts';

describe('typed API client foundation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.sessionToken = null;
    apiClient.csrfToken = null;
  });

  test.each([
    ['/api/v1/dashboard', '/dashboard'],
    ['/api/v1/projects/project%2F1', '/projects/project%2F1'],
    ['/api/v1/tasks/task%201/dispatch', '/tasks/task%201/dispatch'],
  ])('converts canonical API path %s to client-relative path %s', (canonicalPath, clientPath) => {
    expect(toClientPath(canonicalPath)).toBe(clientPath);
  });

  test('rejects a path outside the authoritative API base', () => {
    expect(() => toClientPath('/api/v10/dashboard')).toThrow(/API base path/i);
  });

  test('builds encoded canonical paths for evidenced endpoints', () => {
    expect(apiPaths.project('project/1')).toBe('/api/v1/projects/project%2F1');
    expect(apiPaths.taskDispatch('task 1')).toBe('/api/v1/tasks/task%201/dispatch');
    expect(apiPaths.runCancel('run-1')).toBe('/api/v1/runs/run-1/cancel');
    expect(apiPaths.session).toBe('/api/v1/session');
    expect(apiPaths.events).toBe('/api/v1/events');
  });

  test('passes an AbortSignal through to same-origin requests', async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiClient.get('/dashboard', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/dashboard', expect.objectContaining({
      credentials: 'same-origin',
      signal: controller.signal,
    }));
  });

  test('keeps in-memory bearer and CSRF headers authoritative over caller headers', async () => {
    apiClient.sessionToken = 'memory-bearer';
    apiClient.csrfToken = 'memory-csrf';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiClient.post('/approvals/approval-1/approve', {}, {
      headers: { Authorization: 'caller-bearer', 'X-CSRF-Token': 'caller-csrf' },
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/approvals/approval-1/approve', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer memory-bearer',
        'X-CSRF-Token': 'memory-csrf',
      }),
    }));
  });

  test('exposes structured status and code on API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'approval denied', code: 'APPROVAL_DENIED',
    }), { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' } }));

    await expect(apiClient.get('/approvals')).rejects.toMatchObject({
      name: 'ApiError', status: 403, code: 'APPROVAL_DENIED', message: 'approval denied',
    } satisfies Partial<ApiError>);
  });

  test.each([false, 0, null])('serializes a falsy POST body: %s', async (body) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiClient.post('/example', body);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/example', expect.objectContaining({
      method: 'POST', body: JSON.stringify(body),
    }));
  });

  test('omits the body and resolves undefined for a 204 response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiClient.post('/example')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/example', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });
});
