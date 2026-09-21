import { useEffect } from 'react';
import { eventClient } from '../api/events.js';

/**
 * Инициализирует и управляет подключением `EventClient` к SSE.
 * Подключается к `/events` при монтировании и запускает обновление данных
 * после восстановления соединения.
 */
export function useEventClient() {
  useEffect(() => {
    // Сначала регистрируем обновление данных, затем устанавливаем соединение.
    eventClient.setRefetchCallback(() => {
      // Компоненты получают уведомление через локальное событие браузера.
      window.dispatchEvent(new CustomEvent('sse-reconnect'));
    });

    // Подключаемся к потоку SSE.
    eventClient.connect();

    // Освобождаем соединение при размонтировании.
    return () => {
      eventClient.disconnect();
    };
  }, []);
}

/**
 * Подписывается на уведомления о восстановлении SSE-соединения.
 * Вызывает переданный callback после переподключения клиента.
 */
export function useOnSSEReconnect(callback: () => void) {
  useEffect(() => {
    const handleReconnect = () => callback();
    
    window.addEventListener('sse-reconnect', handleReconnect);
    return () => {
      window.removeEventListener('sse-reconnect', handleReconnect);
    };
  }, [callback]);
}
