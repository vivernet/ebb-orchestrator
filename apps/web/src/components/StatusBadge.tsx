interface StatusBadgeProps {
  status: string;
  label?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
}

/**
 * Отображает переданный статус с визуальным вариантом, выбранным вызывающим кодом.
 * Компонент не нормализует статус и не выполняет policy-проверки.
 */
export default function StatusBadge({ status, label, variant = 'default' }: StatusBadgeProps) {
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

  return <span style={style} title={status}>{label ?? status}</span>;
}
