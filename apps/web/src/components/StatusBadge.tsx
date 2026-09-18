interface StatusBadgeProps {
  status: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
}

/**
 * Представляет пользовательский экран StatusBadge; авторитетные проверки выполняются backend.
 */
export default function StatusBadge({ status, variant = 'default' }: StatusBadgeProps) {
  const variants = {
    default: { bg: '#404040', text: '#e5e5e5' },
    success: { bg: '#2d6a4f', text: '#d8f3dc' },
    warning: { bg: '#9d4edd', text: '#e9d8fd' },
    error: { bg: '#c1121f', text: '#fff0f3' },
  };

  const style = {
    display: 'inline-block',
    padding: '4px 8px',
    borderRadius: '4px',
    backgroundColor: variants[variant].bg,
    color: variants[variant].text,
    fontSize: '12px',
    fontWeight: '500',
  };

  return <span style={style}>{status}</span>;
}
