/**
 * SSE event client with automatic reconnection and refetch capability.
 */

type EventHandler = (data: unknown) => void;

export interface EventClient {
  on(event: string, handler: EventHandler): void;
  connect(): void;
  disconnect(): void;
  setRefetchCallback(callback: () => void): void;
}

function createEventClient(): EventClient {
  const handlers = new Map<string, Set<EventHandler>>();
  let eventSource: EventSource | null = null;
  let onRefetch: (() => void) | null = null;

  function reconnect() {
    disconnect();
    connect();
    if (onRefetch) {
      onRefetch();
    }
  }

  function connect() {
    eventSource = new EventSource('/events');

    eventSource.onmessage = (event) => {
      const dataHandlers = handlers.get(event.type);
      if (dataHandlers) {
        for (const handler of dataHandlers) {
          handler(JSON.parse(event.data));
        }
      }
    };

    eventSource.onerror = () => {
      // On connection error, reconnect after a delay
      setTimeout(reconnect, 5000);
    };
  }

  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
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

export const eventClient = createEventClient();
