/**
 * Клиент SSE с автоматическим переподключением и обновлением read model.
 */
import { apiClient } from './client.js';

type EventHandler = (data: unknown) => void;

interface InvalidationListener {
  (event: string, data: unknown): void;
}

/** Порт браузерного клиента SSE для подписки и управления соединением. */
export interface EventClient {
  on(event: string, handler: EventHandler): void;
  connect(): void;
  disconnect(): void;
  setRefetchCallback(callback: () => void): void;
  onInvalidate(listener: InvalidationListener): void;
}

function createEventClient(): EventClient {
  const handlers = new Map<string, Set<EventHandler>>();
  const invalidationListeners = new Set<InvalidationListener>();
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
      headers: {
        ...(apiClient.sessionToken ? { Authorization: `Bearer ${apiClient.sessionToken}` } : {}),
        ...(apiClient.csrfToken ? { 'X-CSRF-Token': apiClient.csrfToken } : {}),
      },
      signal: nextController.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`);
      await consumeEventStream(response.body, handlers, invalidationListeners);
    }).catch(() => {
      // При переподключении намеренно перечитываем авторитетное состояние.
      window.dispatchEvent(new CustomEvent('sse-reconnect'));
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

    onInvalidate(listener: InvalidationListener) {
      invalidationListeners.add(listener);
    },

    connect,
    disconnect,
  };
}

async function consumeEventStream(
  stream: ReadableStream<Uint8Array>,
  handlers: Map<string, Set<EventHandler>>,
  invalidationListeners: Set<InvalidationListener>,
): Promise<void> {
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
        const packet = buffer.slice(0, boundary);
        dispatchEvent(packet, handlers);
        notifyInvalidation(packet, invalidationListeners);
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
    // Некорректное временное событие не меняет состояние: авторитетны projections.
  }
}

function notifyInvalidation(packet: string, invalidationListeners: Set<InvalidationListener>): void {
  let eventName = 'message';
  const data: string[] = [];
  for (const line of packet.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (data.length === 0) return;
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    for (const listener of invalidationListeners) listener(eventName, parsed);
  } catch {
    // Некорректное временное событие не меняет состояние.
  }
}

export const eventClient = createEventClient();
