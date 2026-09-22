/**
 * Общий компонент для состояний страницы: loading, error, empty, not-found.
 */
interface PageStateProps {
  status: 'loading' | 'error' | 'empty' | 'not-found';
  title?: string;
  message: string;
  onRetry?: () => void;
  onBack?: () => void;
}

/**
 * Отображает универсальные состояния страницы без дублирования markup.
 */
export function PageState({ status, title, message, onRetry, onBack }: PageStateProps) {
  return (
    <div className="page-state" role={status === 'error' ? 'alert' : 'status'}>
      {title && <h1>{title}</h1>}
      <p>{message}</p>
      {(status === 'error' || status === 'not-found') && (
        <div className="page-actions">
          {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
          {onBack && <button type="button" onClick={onBack}>Back</button>}
        </div>
      )}
    </div>
  );
}

/**
 * Отображает пустое состояние с пояснением и необязательным действием.
 */
export function EmptyState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <p>{message}</p>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}

/**
 * Отображает ошибку с безопасным сообщением и опциональной кнопкой повтора.
 */
export function ErrorAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="inline-alert" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      {onRetry && <button type="button" style={{ marginLeft: '8px' }} onClick={onRetry}>Retry</button>}
    </div>
  );
}

/**
 * Бейдж статуса с каноническим кодом и необязательным human-readable лейблом.
 */
interface StatusBadgeProps {
  status: string;
  label?: string;
  variant?: 'success' | 'warning' | 'danger' | 'info';
}

/**
 * Отображает статусный бейдж с каноническим кодом.
 */
export function StatusBadge({ status, label, variant = 'info' }: StatusBadgeProps) {
  const variants: Record<string, string> = {
    success: '#1d365d',
    warning: '#3a4d70',
    danger: '#3e202b',
    info: '#1d365d',
  };

  return (
    <span
      className="status-chip"
      style={{
        background: variants[variant] ?? variants.info,
      }}
      title={status}
    >
      {label ?? status}
    </span>
  );
}
