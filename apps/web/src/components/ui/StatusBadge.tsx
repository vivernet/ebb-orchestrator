import { statusLabel } from '../../i18n/ru.js';

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
    default: 'badge dim',
    success: 'badge good',
    warning: 'badge warn',
    error: 'badge bad',
  } as const;

  const localized = statusLabel(status);
  const visibleLabel = localized === 'Неизвестный статус' && label && /^[\p{Script=Cyrillic}\s\d.,!?—-]+$/u.test(label) ? label : localized;
  return <span className={variants[variant]} data-status={status} title={visibleLabel}>{visibleLabel}</span>;
}
