import { describe, expect, test, vi } from 'vitest';
import { canonicalQueryKey, createQueryStore } from '../src/state/query-store.js';

describe('canonicalQueryKey', () => {
  test('normalizes parameter order and omits undefined values', () => {
    expect(canonicalQueryKey('/tasks', { page: 2, filter: 'active', omitted: undefined }))
      .toBe('/tasks?filter=active&page=2');
  });

  test('canonicalizes equivalent empty parameter sets', () => {
    expect(canonicalQueryKey('/tasks')).toBe('/tasks');
    expect(canonicalQueryKey('/tasks', {})).toBe('/tasks');
  });
});

describe('query store', () => {
  test('starts idle and publishes loading then success with a timestamp', async () => {
    const store = createQueryStore({ now: () => 1234 });
    const states: string[] = [];
    const key = canonicalQueryKey('/tasks', { id: 'task-1' });

    store.subscribe(key, (state) => states.push(state.status));
    expect(store.get(key)).toMatchObject({ status: 'idle', data: undefined, updatedAt: null });

    await store.fetch('/tasks', { id: 'task-1' }, async () => ({ id: 'task-1' }));

    expect(states).toEqual(['loading', 'success']);
    expect(store.get<{ id: string }>(key)).toMatchObject({
      status: 'success',
      data: { id: 'task-1' },
      updatedAt: 1234,
      isStale: false,
    });
  });

  test('deduplicates concurrent requests and serves the successful cache', async () => {
    const store = createQueryStore();
    let resolve: ((value: { value: number }) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<{ value: number }>((done) => { resolve = done; }));

    const first = store.fetch('/usage', undefined, fetcher);
    const second = store.fetch('/usage', undefined, fetcher);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolve?.({ value: 7 });
    await expect(first).resolves.toEqual({ value: 7 });
    await expect(store.fetch('/usage', undefined, fetcher)).resolves.toEqual({ value: 7 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('publishes errors and allows a later fetch to retry', async () => {
    const store = createQueryStore();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ ok: true });

    await expect(store.fetch('/settings', undefined, fetcher)).rejects.toThrow('temporary failure');
    expect(store.get('/settings')).toMatchObject({ status: 'error', isStale: true });
    await expect(store.fetch('/settings', undefined, fetcher)).resolves.toEqual({ ok: true });
    expect(store.get('/settings')).toMatchObject({ status: 'success', data: { ok: true }, isStale: false });
  });

  test('invalidates cached data and refetches it authoritatively', async () => {
    const store = createQueryStore();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });

    await store.fetch('/dashboard', undefined, fetcher);
    store.invalidate('/dashboard');
    expect(store.get('/dashboard')).toMatchObject({ status: 'success', data: { version: 1 }, isStale: true });

    await expect(store.refetch('/dashboard', undefined, fetcher)).resolves.toEqual({ version: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.get('/dashboard')).toMatchObject({ status: 'success', data: { version: 2 }, isStale: false });
  });

  test('does not let an invalidated request publish a stale result', async () => {
    const store = createQueryStore();
    let resolveOld: ((value: { version: number }) => void) | undefined;
    const oldFetcher = vi.fn(() => new Promise<{ version: number }>((resolve) => { resolveOld = resolve; }));
    const newFetcher = vi.fn().mockResolvedValue({ version: 2 });

    const oldRequest = store.fetch('/dashboard', undefined, oldFetcher);
    store.invalidate('/dashboard');
    await expect(store.refetch('/dashboard', undefined, newFetcher)).resolves.toEqual({ version: 2 });
    resolveOld?.({ version: 1 });
    await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });

    expect(store.get('/dashboard')).toMatchObject({ status: 'success', data: { version: 2 }, isStale: false });
  });
});
