import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { apiClient } from '../src/api/client.js';

describe('SSE EventClient integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.sessionToken = 'session-token';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(''));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.sessionToken = null;
  });

  test('initializes an authenticated stream at the server SSE route', async () => {
    const { eventClient } = await import('../src/api/events.js');
    eventClient.connect();

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/events', expect.objectContaining({
      headers: { Authorization: 'Bearer session-token' },
    })));
    eventClient.disconnect();
  });

  test('sets up refetch callback for SSE reconnects', async () => {
    const { eventClient } = await import('../src/api/events.js');
    const refetchSpy = vi.fn();
    eventClient.setRefetchCallback(refetchSpy);

    expect(() => eventClient.setRefetchCallback(refetchSpy)).not.toThrow();
  });

  test('disconnects an active authenticated stream', async () => {
    const { eventClient } = await import('../src/api/events.js');
    eventClient.connect();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    eventClient.disconnect();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
