/**
 * SSE event client with automatic reconnection and refetch capability.
 */

type EventHandler = (data: unknown) => void;

export interface EventClient {
  on(event: string, handler: EventHandler): void;
  connect(): void;
  disconnect(): void;
}

function createEventClient(): EventClient {
  const handlers = new Map<string, Set<EventHandler>>();
  let eventSource: EventSource | null = null;

  function reconnect() {
    disconnect();
    connect();
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

    connect,
    disconnect,
  };
}

export const eventClient = createEventClient();
