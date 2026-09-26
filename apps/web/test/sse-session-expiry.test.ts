import { afterEach, describe, expect, test, vi } from 'vitest';

async function loadClient() {
  vi.resetModules();
  return import('../src/api/events.js');
}

describe('SSE session expiry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('401 aborts the stream and emits one expiry signal without reconnecting', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    const { eventClient } = await loadClient();
    const expired = vi.fn();
    const unsubscribe = eventClient.onSessionExpired(expired);

    eventClient.connect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsubscribe();
    eventClient.disconnect();
  });

  test('fresh authentication re-arms SSE after a terminal 401', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    const { eventClient } = await loadClient();

    eventClient.connect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    eventClient.rearmAfterAuth();
    eventClient.connect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    eventClient.disconnect();
  });

  test('503 follows bounded reconnect and disconnect cancels it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const { eventClient } = await loadClient();
    eventClient.connect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    eventClient.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
