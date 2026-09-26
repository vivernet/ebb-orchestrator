import { useCallback } from 'react';
import { apiPaths, type SettingsProjection } from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';

function valueOrUnavailable(value: unknown): string {
  return value === null || value === undefined ? 'Недоступно' : String(value);
}

/** Представляет read-only Settings projection; unsupported policy не выводится как факт. */
export default function SettingsPage() {
  const settingsPath = toClientPath(apiPaths.settings);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<SettingsProjection>(settingsPath, { signal }), [settingsPath]);
  const query = useQuery(null, settingsPath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка настроек…" />;
  if (query.status === 'error' || !query.data) {
    return <PageState status="error" title="Настройки" message={`Не удалось загрузить настройки: ${apiErrorMessage(query.error instanceof ApiError ? query.error.code : undefined)}`} onRetry={retry} />;
  }

  const { global } = query.data.effectiveHierarchy;
  const security = query.data.securitySettings;

  return (
    <div className="settings-page">
      <h1>Настройки</h1>

      <section aria-label="Иерархия конфигурации">
        <h2>Действующая иерархия</h2>
        <h3>Глобально</h3>
        <p>Версия схемы: {valueOrUnavailable(global.schemaVersion)}</p>
        <p>Общий максимум: {valueOrUnavailable(global.globalMax)}</p>
        <p>Максимум для проекта: {valueOrUnavailable(global.projectMax)}</p>
        <p>Ёмкость ролей: {global.roleCapacity ? JSON.stringify(global.roleCapacity) : 'Недоступно'}</p>

        <h3>Проект</h3>
        <p>Недоступно: эта конечная точка только для чтения не предоставляет переопределения проекта.</p>

        <h3>Роль</h3>
        <p>Недоступно: эта конечная точка только для чтения не предоставляет переопределения ролей.</p>

        <h3>Задача/эпик</h3>
        <p>Недоступно: эта конечная точка только для чтения не предоставляет переопределения задач и эпиков.</p>
      </section>

      <section aria-label="Параметры безопасности">
        <h2>Безопасность</h2>
        <p><strong>Действует наиболее строгое ограничение:</strong> {valueOrUnavailable(security.mostRestrictiveWins)}</p>
        <p><strong>Локальный режим:</strong> {valueOrUnavailable(security.localModeEnabled)}</p>
        <p>Сведения о политике безопасности недоступны в этой проекции настроек только для чтения.</p>
      </section>
    </div>
  );
}
