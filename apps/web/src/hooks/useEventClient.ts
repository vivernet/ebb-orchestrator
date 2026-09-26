import { useEffect } from 'react';
import { eventClient } from '../api/events.js';

/** Подключает SSE и переводит приложение в expired при HTTP 401. */
export function useEventClient(onSessionExpired: () => void) {
  useEffect(() => {
    eventClient.setRefetchCallback(() => window.dispatchEvent(new CustomEvent('sse-reconnect')));
    const unsubscribe = eventClient.onSessionExpired(onSessionExpired);
    eventClient.connect();
    return () => { unsubscribe(); eventClient.disconnect(); };
  }, [onSessionExpired]);
}

/** Подписывает экран на refetch signal после сетевого reconnect. */
export function useOnSSEReconnect(callback: () => void) {
  useEffect(() => { window.addEventListener('sse-reconnect', callback); return () => window.removeEventListener('sse-reconnect', callback); }, [callback]);
}
