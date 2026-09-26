import { useEffect, useState } from 'react';
import { ru } from '../../i18n/ru.js';

interface ConnectionIndicatorProps {
  /** Подписывается на события подключения браузера. */
  autoSubscribe?: boolean;
  /** Класс для обертки (по умолчанию: 'connection-indicator'). */
  className?: string;
}

/**
 * Компонент индикатора подключения к сети.
 */
export function ConnectionIndicator({ autoSubscribe = true, className = 'connection-indicator' }: ConnectionIndicatorProps) {
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    if (!autoSubscribe || typeof window === 'undefined') return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [autoSubscribe]);

  return (
    <span role="img" className={className} data-online={isOnline} title={isOnline ? ru.common.online : ru.common.offline} aria-label={isOnline ? ru.common.online : ru.common.offline}>
      {isOnline ? '🟢' : '🔴'}
    </span>
  );
}
