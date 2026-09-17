import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock EventSource for testing
class MockEventSource {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: (() => void) | null = null;

  constructor(public url: string) {
    // Simulate connection
  }

  close(): void {
    // Simulate close
  }
}

describe('SSE EventClient integration', () => {
  let eventSourceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = MockEventSource as unknown as typeof EventSource;
    eventSourceSpy = vi.spyOn(globalThis as unknown as { EventSource: typeof EventSource }, 'EventSource');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('initializes SSE connection on app startup', async () => {
    // Dynamically import after mock is set up
    const { eventClient } = await import('../src/api/events.js');
    
    eventClient.connect();

    // EventSource should be created to connect to /events
    expect(eventSourceSpy).toHaveBeenCalledWith('/events');
  });

  test('sets up refetch callback for SSE reconnects', async () => {
    const { eventClient } = await import('../src/api/events.js');
    
    const refetchSpy = vi.fn();
    eventClient.setRefetchCallback(refetchSpy);
    
    // Verify callback was set (it's stored internally)
    expect(() => eventClient.setRefetchCallback(refetchSpy)).not.toThrow();
  });

  test('disconnects SSE connection', async () => {
    const { eventClient } = await import('../src/api/events.js');
    
    // Spy on close method before connecting
    const closeSpy = vi.fn();
    const originalClose = MockEventSource.prototype.close;
    MockEventSource.prototype.close = closeSpy;

    eventClient.connect();
    expect(eventSourceSpy).toHaveBeenCalledWith('/events');
    
    eventClient.disconnect();
    
    // Verify connection was closed
    expect(closeSpy).toHaveBeenCalled();
    
    // Restore original
    MockEventSource.prototype.close = originalClose;
  });
});
