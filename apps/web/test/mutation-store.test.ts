import { describe, expect, test, vi } from 'vitest';
import { createMutationStore } from '../src/state/mutation-store.js';

describe('mutation store', () => {
  test('publishes pending and confirmed success only after authoritative refetch', async () => {
    const store = createMutationStore();
    const states: string[] = [];
    const refetch = vi.fn().mockResolvedValue({ status: 'APPROVED' });
    store.subscribe('approval-1', (state) => states.push(state.status));

    await expect(store.execute('approval-1', async () => ({ status: 'ACCEPTED' }), refetch))
      .resolves.toEqual({ status: 'ACCEPTED' });

    expect(states).toEqual(['pending', 'success']);
    expect(refetch).toHaveBeenCalledOnce();
    expect(store.get('approval-1')).toMatchObject({ status: 'success', data: { status: 'ACCEPTED' } });
  });

  test('deduplicates a pending command by key', async () => {
    const store = createMutationStore();
    let resolve: ((value: string) => void) | undefined;
    const command = vi.fn(() => new Promise<string>((done) => { resolve = done; }));

    const first = store.execute('run-1-cancel', command);
    const second = store.execute('run-1-cancel', command);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(command).toHaveBeenCalledOnce();

    resolve?.('CANCELLED');
    await expect(first).resolves.toBe('CANCELLED');
  });

  test('preserves a failed command and allows retry after the pending state clears', async () => {
    const store = createMutationStore();
    const command = vi.fn()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce('ok');

    await expect(store.execute('approval-2', command)).rejects.toThrow('conflict');
    expect(store.get('approval-2')).toMatchObject({ status: 'error' });
    await expect(store.execute('approval-2', command)).resolves.toBe('ok');
    expect(store.get('approval-2')).toMatchObject({ status: 'success', data: 'ok' });
  });

  test('reports refetch failure instead of claiming confirmed success', async () => {
    const store = createMutationStore();
    const refetch = vi.fn().mockRejectedValue(new Error('refresh unavailable'));

    await expect(store.execute('task-1-dispatch', async () => ({ accepted: true }), refetch))
      .rejects.toThrow('refresh unavailable');
    expect(store.get('task-1-dispatch')).toMatchObject({ status: 'error' });
  });

  test('turns a synchronous command throw into a retryable error state', async () => {
    const store = createMutationStore();
    const command = vi.fn(() => { throw new Error('invalid command'); });

    await expect(store.execute('task-1-pause', command)).rejects.toThrow('invalid command');
    expect(store.get('task-1-pause')).toMatchObject({ status: 'error' });
    expect(command).toHaveBeenCalledOnce();
  });
});
