/**
 * Статусные подписи и баннеры провайдеров (plan-24, Task 6).
 *
 * Состояния: loading, empty (не настроен), error, unavailable, connected,
 * pending (flow авторизации ожидает подтверждения), expired и disconnected.
 * Никаких секретов и endpoint URL в статусных проекциях нет.
 */

import type { ProviderSettingsProjection } from '@ebb-orchestrator/contracts';
import type { ProviderAuthStatusProjection } from './provider-api.js';
import { ru } from '../../../i18n/ru.js';

export type ProviderBannerState =
  | 'loading'
  | 'empty'
  | 'error'
  | 'unavailable'
  | 'connected'
  | 'pending'
  | 'expired'
  | 'disconnected'
  | 'disabled';

export interface ProviderStatusView {
  state: ProviderBannerState;
  label: string;
  hint?: string;
}

/** Вычисляет статусное представление из проекций (без сетевых вызовов). */
export function providerStatusView(
  status: ProviderSettingsProjection | undefined,
  authStatus: ProviderAuthStatusProjection | undefined,
  loadError: unknown,
  loading: boolean,
): ProviderStatusView {
  if (loading && !status) return { state: 'loading', label: ru.common.loading };
  if (loadError) return { state: 'error', label: ru.providers.error, hint: ru.errors.default };

  const flows = authStatus?.activeFlows ?? [];
  const hasPendingFlow = flows.some((flow) => flow.status === 'PENDING');
  const hasExpiredFlow = flows.some((flow) => flow.status === 'EXPIRED');

  if (!status) return { state: 'empty', label: ru.providers.notConfigured };
  if (!status.enabled) return { state: 'disabled', label: ru.providers.disabled };
  if (hasPendingFlow) return { state: 'pending', label: ru.providers.pending, hint: ru.providers.authMethodHints['oauth-device-code'] };
  if (hasExpiredFlow) return { state: 'expired', label: ru.providers.expired };
  if (status.hasCredential && status.credentialStatus === 'ACTIVE') {
    return { state: 'connected', label: ru.providers.connected };
  }
  if (status.credentialStatus === 'DISCONNECTED') return { state: 'disconnected', label: ru.providers.disconnected };
  return { state: 'empty', label: ru.providers.notConfigured };
}

/** Компактный бейдж статуса (используется в списке каталога). */
export function ProviderStatusBadge({ state, label }: { state: ProviderBannerState; label: string }) {
  return (
    <span className={`provider-status provider-status--${state}`} role="status">
      {label}
    </span>
  );
}

/** Полноразмерный баннер статуса на странице провайдера. */
export function ProviderStatusBanner({ view }: { view: ProviderStatusView }) {
  return (
    <section className={`provider-banner provider-banner--${view.state}`} aria-label="Статус провайдера">
      <strong>{view.label}</strong>
      {view.hint && <p>{view.hint}</p>}
    </section>
  );
}
