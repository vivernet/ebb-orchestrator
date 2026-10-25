import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiPaths, type SettingsProjection } from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';

function valueOrUnavailable(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return value === null || value === undefined ? 'Недоступно' : String(value);
}

/** Представляет read-only Settings projection; unsupported policy не выводится как факт. */
function providerModelLabel(model: string): string {
  return model === 'default' ? 'по умолчанию (Ebb)' : model;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

/**
 * Страница «Настройки»: показывает действующую иерархию конфигурации,
 * безопасность, статус провайдеров и форму редактирования глобальной
 * конфигурации планировщика (PUT /scheduler/config).
 */
export default function SettingsPage() {
  const settingsPath = toClientPath(apiPaths.settings);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<SettingsProjection>(settingsPath, { signal }), [settingsPath]);
  const query = useQuery(null, settingsPath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [saveState, setSaveState] = useState<MutationState<unknown>>(() => mutationStore.get('scheduler-config'));
  useEffect(() => mutationStore.subscribe('scheduler-config', setSaveState), [mutationStore]);
  const [editing, setEditing] = useState(false);
  const [globalMaxInput, setGlobalMaxInput] = useState('');
  const [projectMaxInput, setProjectMaxInput] = useState('');

  useEffect(() => {
    if (query.data) {
      const global = query.data.effectiveHierarchy.global;
      setGlobalMaxInput(global.globalMax === null ? '' : String(global.globalMax));
      setProjectMaxInput(global.projectMax === null ? '' : String(global.projectMax));
    }
  }, [query.data]);

  const save = async () => {
    const global = query.data?.effectiveHierarchy.global;
    if (!global) return;
    const globalMax = parseOptionalNumber(globalMaxInput);
    const projectMax = parseOptionalNumber(projectMaxInput);
    if (Number.isNaN(globalMax) || Number.isNaN(projectMax)) return;
    await mutationStore.execute('scheduler-config', () => apiClient.put(
      toClientPath('/api/v1/scheduler/config'),
      { ...global, globalMax, projectMax },
    ), async () => { setEditing(false); await query.refetch(); }).catch(() => undefined);
  };

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка настроек…" />;
  if (query.status === 'error' || !query.data) {
    return <PageState status="error" title="Настройки" message={`Не удалось загрузить настройки: ${apiErrorMessage(query.error instanceof ApiError ? query.error.code : undefined)}`} onRetry={retry} />;
  }

  const { global } = query.data.effectiveHierarchy;
  const security = query.data.securitySettings;

  return (
    <div className="settings-page page-stack reference-screen reference-screen--settings">
      <div className="topbar">
        <div>
          <h1>Настройки</h1>
          <div className="sub">Глобальные лимиты, выбор провайдера и сведения о безопасности.</div>
        </div>
      </div>

      {saveState.status === 'error' && <p className="inline-alert" role="alert">{`Не удалось сохранить настройки: ${apiErrorMessage(saveState.error instanceof ApiError ? saveState.error.code : undefined)}`}</p>}
      {saveState.status === 'success' && <p role="status">Настройки сохранены</p>}

      <div className="settings-layout">
        <nav className="settings-section-nav" aria-label="Разделы настроек">
          <a href="#settings-models">Провайдеры и модели</a>
          <a href="#settings-scheduler">Планировщик</a>
          <a href="#settings-hierarchy">Иерархия лимитов</a>
          <a href="#settings-security">Безопасность</a>
        </nav>
        <div className="reference-column settings-content">
        <section className="reference-panel" id="settings-models" aria-label="Роли и модели">
          <div className="panel-head"><h3>Роли и модели</h3></div>
          <p>Распределение моделей по ролям и управление провайдерами.</p>
          <Link to="/settings/providers">Открыть каталог провайдеров</Link>
          {query.data.providerSelection && (
            <>
              <p>Модель по умолчанию: {providerModelLabel(query.data.providerSelection.defaultModel)}</p>
              <ul>
                {query.data.providerSelection.models.map((option) => (
                  <li key={option.model}>
                    <strong>{option.model}</strong> — <span>{option.provider}</span> — {option.keyConfigured ? <span>Настроен</span> : <span>Не настроен</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p role="note">Ключи хранятся в EBB_ORCHESTRATOR_HOME/.env и не отображаются. Модель для запуска выбирается в Ebb.</p>
        </section>

        <section className="reference-panel" id="settings-scheduler" aria-label="Планировщик">
          <div className="panel-head"><h3>Планировщик (scheduler)</h3></div>
          <p>Детерминированные лимиты параллельности и приоритеты.</p>
          <div className="row"><span className="muted">Версия схемы</span><span>{valueOrUnavailable(global.schemaVersion)}</span></div>
          {!editing ? (
            <>
              <div className="row"><span className="muted">Общий максимум</span><span>{valueOrUnavailable(global.globalMax)}</span></div>
              <div className="row"><span className="muted">Максимум для проекта</span><span>{valueOrUnavailable(global.projectMax)}</span></div>
              <div className="row"><span className="muted">Ёмкость ролей</span><span>{global.roleCapacity ? JSON.stringify(global.roleCapacity) : 'Недоступно'}</span></div>
              <div className="top-actions" style={{ marginTop: '12px' }}>
                <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>Изменить</button>
              </div>
            </>
          ) : (
            <div style={{ marginTop: '12px' }}>
              <div style={{ display: 'grid', gap: '10px' }}>
                <label htmlFor="settings-global-max">Общий максимум</label>
                <input id="settings-global-max" type="number" min={0} value={globalMaxInput} onChange={(event) => setGlobalMaxInput(event.target.value)} />
                <label htmlFor="settings-project-max">Максимум для проекта</label>
                <input id="settings-project-max" type="number" min={0} value={projectMaxInput} onChange={(event) => setProjectMaxInput(event.target.value)} />
              </div>
              <div className="top-actions" style={{ marginTop: '12px' }}>
                <button type="button" className="btn-ghost" onClick={() => { setEditing(false); setGlobalMaxInput(global.globalMax === null ? '' : String(global.globalMax)); setProjectMaxInput(global.projectMax === null ? '' : String(global.projectMax)); }}>Отменить</button>
                <button type="button" className="btn-primary" disabled={saveState.status === 'pending'} onClick={() => void save()}>Сохранить</button>
              </div>
            </div>
          )}
        </section>

      <section className="reference-panel" id="settings-hierarchy" aria-label="Действующая иерархия">
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

      <section className="reference-panel" id="settings-security" aria-label="Безопасность">
        <h2>Безопасность</h2>
        <p><strong>Действует наиболее строгое ограничение:</strong> {valueOrUnavailable(security.mostRestrictiveWins)}</p>
        <p><strong>Локальный режим:</strong> {valueOrUnavailable(security.localModeEnabled)}</p>
        {security.localModeEnabled && <p role="note">Local Mode изолирует policy, tools и credentials, но не является OS sandbox и не изолирует process, filesystem или network при запуске кода проекта.</p>}
      </section>
      </div>
      </div>
    </div>
  );
}
