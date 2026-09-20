/**
 * SSE event client with automatic reconnection and refetch capability.
 */
import { authenticatedHeaders } from './client.js';

type EventHandler = (data: unknown) => void;

export interface EventClient {
  on(event: string, handler: EventHandler): void;
  connect(): void;
  disconnect(): void;
  setRefetchCallback(callback: () => void): void;
}

function createEventClient(): EventClient {
  const handlers = new Map<string, Set<EventHandler>>();
  let controller: AbortController | null = null;
  let retryTimer: number | null = null;
  let onRefetch: (() => void) | null = null;

  function scheduleReconnect() {
    if (controller || retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      connect();
      onRefetch?.();
    }, 5_000);
  }

  function connect() {
    if (controller) return;
    const nextController = new AbortController();
    controller = nextController;
    void fetch('/api/v1/events', {
      credentials: 'same-origin',
      headers: authenticatedHeaders(),
      signal: nextController.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`);
      await consumeEventStream(response.body, handlers);
    }).catch(() => {
      // Reconnect is deliberate; the authoritative state is re-fetched on reconnect.
    }).finally(() => {
      if (controller !== nextController) return;
      controller = null;
      if (!nextController.signal.aborted) scheduleReconnect();
    });
  }

  function disconnect() {
    controller?.abort();
    controller = null;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  return {
    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
    },

    setRefetchCallback(callback: () => void) {
      onRefetch = callback;
    },

    connect,
    disconnect,
  };
}

async function consumeEventStream(stream: ReadableStream<Uint8Array>, handlers: Map<string, Set<EventHandler>>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        dispatchEvent(buffer.slice(0, boundary), handlers);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatchEvent(packet: string, handlers: Map<string, Set<EventHandler>>): void {
  let eventName = 'message';
  const data: string[] = [];
  for (const line of packet.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (data.length === 0) return;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    for (const handler of handlers.get(eventName) ?? []) handler(parsed);
  } catch {
    // Malformed ephemeral events are ignored; projections are authoritative.
  }
}

export const eventClient = createEventClient();
