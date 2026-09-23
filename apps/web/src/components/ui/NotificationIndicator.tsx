interface NotificationIndicatorProps {
  count?: number;
  /** Показывает красную точку, даже если count=0. */
  forceShow?: boolean;
  /** Класс для обертки (по умолчанию: 'notification-indicator'). */
  className?: string;
}

/**
 * Компонент индикатора уведомлений.
 */
export function NotificationIndicator({
  count = 0,
  forceShow = false,
  className = 'notification-indicator',
}: NotificationIndicatorProps) {
  const hasNotifications = count > 0 || forceShow;
  return (
    <span className={className} data-has-notifications={hasNotifications} title="Notifications">
      {hasNotifications && count > 0 && (
        <span className="notification-badge">{count > 99 ? '99+' : count}</span>
      )}
    </span>
  );
}
