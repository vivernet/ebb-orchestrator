import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { apiPaths, type ProjectConfigV2 } from '@ebb-orchestrator/contracts';
import { ApiError, getProjectConfig, getProjectIndex, getSettings, saveProjectConfigCandidate, toClientPath, updateSchedulerConfig } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';

function valueOrUnavailable(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return value === null || value === undefined ? 'Недоступно' : String(value);
}

function providerModelLabel(model: string): string {
  return model === 'default' ? 'по умолчанию (Ebb)' : model;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function prefillFromActive(active: { normalizedConfig?: Record<string, unknown> } | null): ProjectConfigV2 {
  const nc = active?.normalizedConfig ?? {};
  const rawRoles = Array.isArray(nc.roles) ? nc.roles : [];
  const roles = rawRoles
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && typeof entry.role === 'string')
    .map((entry) => ({
      role: String(entry.role),
      provider: typeof entry.provider === 'string' ? entry.provider : null,
      model: typeof entry.model === 'string' ? entry.model : null,
    }));
  const rawScheduler = typeof nc.scheduler === 'object' && nc.scheduler !== null ? nc.scheduler as Record<string, unknown> : {};
  const rawRecovery = typeof nc.recovery === 'object' && nc.recovery !== null ? nc.recovery as Record<string, unknown> : {};
  const rawGithub = typeof nc.github === 'object' && nc.github !== null ? nc.github as Record<string, unknown> : {};
  const rawBudgets = Array.isArray(nc.budgets) ? nc.budgets : [];
  return {
    projectDisplayName: typeof nc.projectDisplayName === 'string' ? nc.projectDisplayName : '',
    defaultBranch: typeof nc.defaultBranch === 'string' ? nc.defaultBranch : null,
    roles,
    scheduler: {
      concurrency: intOr(rawScheduler.concurrency, 1),
      enablePriorityAging: boolOr(rawScheduler.enablePriorityAging, false),
      criticalPathBoost: boolOr(rawScheduler.criticalPathBoost, false),
    },
    recovery: {
      resumeSessions: boolOr(rawRecovery.resumeSessions, false),
      maxAttempts: intOr(rawRecovery.maxAttempts, 1),
      recoveryCycleMinutes: intOr(rawRecovery.recoveryCycleMinutes, 30),
      abortOnNoProgressDays: intOr(rawRecovery.abortOnNoProgressDays, 2),
    },
    github: {
      syncEnabled: boolOr(rawGithub.syncEnabled, false),
      issueLinking: boolOr(rawGithub.issueLinking, false),
      pullRequestSync: boolOr(rawGithub.pullRequestSync, false),
    },
    budgets: rawBudgets.filter((entry) => typeof entry === 'object' && entry !== null),
  };
}

interface ProjectConfigEditorState {
  status: 'idle' | 'loading' | 'blocked' | 'error' | 'success';
  activeManifestHash: string | null;
  settings: ProjectConfigV2 | null;
  degraded: boolean;
  error: unknown | null;
}

interface SavedCandidateView {
  candidateId: string;
  manifestHash: string;
  expectedManifestHash: string;
  diff: { added: string[]; removed: string[]; modified: string[] };
  status: string;
  createdAt: string;
}

/**
 * Страница «Настройки»: действующая иерархия, безопасность, статус провайдеров
 * и редактор неактивированного кандидата Project Config (активация — только exact-hash approval).
 */
export default function SettingsPage({ initialProjectId }: { initialProjectId?: string } = {}) {
  const settingsPath = toClientPath(apiPaths.settings);
  const fetcher = useCallback((signal: AbortSignal) => getSettings({ signal }), []);
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

  /**
   * Сохранение конфигурации планировщика идёт через конечную точку
   * /api/v1/scheduler/config (apiPaths.schedulerConfig) и валидированный
   * адаптер updateSchedulerConfig: строгая схема запроса, путь — только builder.
   */
  const save = async () => {
    const global = query.data?.effectiveHierarchy.global;
    if (!global) return;
    const globalMax = parseOptionalNumber(globalMaxInput);
    const projectMax = parseOptionalNumber(projectMaxInput);
    if (Number.isNaN(globalMax) || Number.isNaN(projectMax)) return;
    await mutationStore.execute('scheduler-config', () => updateSchedulerConfig({
      schemaVersion: global.schemaVersion ?? 1,
      globalMax,
      projectMax,
      roleCapacity: global.roleCapacity ?? {},
    }), async () => { setEditing(false); await query.refetch(); }).catch(() => undefined);
  };

  const [editorProjectId, setEditorProjectId] = useState<string | null>(initialProjectId ?? null);
  const [projects, setProjects] = useState<Array<{ id: string; displayName: string }>>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const chooseProject = useCallback(() => {
    setProjectsLoading(true);
    getProjectIndex()
      .then((page) => setProjects(page.items.map((entry) => ({ id: entry.id, displayName: entry.displayName }))))
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoading(false));
  }, []);
  const [editor, setEditor] = useState<ProjectConfigEditorState>({ status: 'idle', activeManifestHash: null, settings: null, degraded: false, error: null });
  const [savedCandidate, setSavedCandidate] = useState<SavedCandidateView | null>(null);
  const [candidateState, setCandidateState] = useState<MutationState<unknown>>(() => mutationStore.get('config-candidate'));
  useEffect(() => mutationStore.subscribe('config-candidate', setCandidateState), [mutationStore]);

  const loadEditor = useCallback((projectId: string) => {
    setEditorProjectId(projectId);
    setSavedCandidate(null);
    setEditor({ status: 'loading', activeManifestHash: null, settings: null, degraded: false, error: null });
    getProjectConfig(projectId)
      .then((projection) => {
        const { degraded, candidateInvalid, active } = projection;
        if (degraded || candidateInvalid || !active || typeof active.manifestHash !== 'string') {
          setEditor({ status: 'blocked', activeManifestHash: null, settings: null, degraded: true, error: null });
          return;
        }
        setEditor({
          status: 'success',
          activeManifestHash: active.manifestHash,
          settings: prefillFromActive(active),
          degraded: false,
          error: null,
        });
      })
      .catch((error: unknown) => setEditor({ status: 'error', activeManifestHash: null, settings: null, degraded: false, error }));
  }, []);

  useEffect(() => {
    if (initialProjectId) loadEditor(initialProjectId);
  }, [initialProjectId, loadEditor]);

  const updateSettings = useCallback((patch: Partial<ProjectConfigV2>) => {
    setEditor((prev) => (prev.settings ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
  }, []);

  const saveCandidate = async () => {
    if (!editorProjectId || !editor.settings || !editor.activeManifestHash) return;
    await mutationStore.execute('config-candidate', () => saveProjectConfigCandidate(editorProjectId!, {
      expectedManifestHash: editor.activeManifestHash!,
      settings: editor.settings!,
    }), () => Promise.resolve())
      .then((candidate) => setSavedCandidate({
        candidateId: candidate.candidateId,
        manifestHash: candidate.manifestHash,
        expectedManifestHash: candidate.expectedManifestHash,
        diff: candidate.diff,
        status: candidate.status,
        createdAt: candidate.createdAt,
      }))
      .catch(() => undefined);
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
          <div className="sub">Конфигурация пространства, иерархия лимитов и кандидаты конфигурации проекта.</div>
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
          <a href="#settings-project-config">Конфигурация проекта</a>
          <a href="#settings-budgets">Бюджеты</a>
          <span className="settings-nav-readonly">Процессы</span>
          <span className="settings-nav-readonly">Среда выполнения</span>
          <span className="settings-nav-readonly">Восстановление</span>
          <span className="settings-nav-readonly">Разрешения</span>
          <span className="settings-nav-readonly">Рекомендации</span>
          <span className="settings-nav-readonly">Секреты</span>
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

      <section className="reference-panel" id="settings-project-config" aria-label="Конфигурация проекта">
        <div className="section-heading"><h2>Конфигурация проекта</h2><p>Только переопределения проекта; кандидат не активирует конфигурацию до отдельного approval.</p></div>

        {editorProjectId === null && (
          <div>
            {projects.length === 0 ? (
              <EmptyState message="Проект не выбран." action={<button type="button" className="btn-primary" disabled={projectsLoading} onClick={() => void chooseProject()}>{projectsLoading ? 'Загрузка проектов…' : 'Выбрать проект'}</button>} />
            ) : (
              <div>
                <p>Выберите проект для редактирования конфигурации:</p>
                <ul className="reference-record-list">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <button type="button" className="btn-ghost" onClick={() => loadEditor(project.id)}>{project.displayName || project.id}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {editorProjectId !== null && editor.status === 'loading' && <p>Загрузка конфигурации проекта…</p>}
        {editorProjectId !== null && editor.status === 'error' && <ErrorAlert message={`Не удалось загрузить конфигурацию проекта: ${apiErrorMessage(editor.error instanceof ApiError ? editor.error.code : undefined)}`} onRetry={() => loadEditor(editorProjectId!)} />}
        {editorProjectId !== null && editor.status === 'blocked' && (
          <p className="reference-callout">Конфигурация проекта повреждена или активная ревизия отсутствует; редактор кандидата недоступен до восстановления.</p>
        )}

        {editorProjectId !== null && editor.status === 'success' && editor.settings && (
          <>
            {candidateState.status === 'error' && <ErrorAlert message={`Не удалось сохранить кандидата: ${apiErrorMessage(candidateState.error instanceof ApiError ? candidateState.error.code : undefined)}`} />}
            <form onSubmit={(event) => { event.preventDefault(); void saveCandidate(); }}>
              <div className="settings-editor-grid">
                <div className="form-field">
                  <label htmlFor="settings-project-name">Название проекта</label>
                  <input id="settings-project-name" value={editor.settings.projectDisplayName} onChange={(event) => updateSettings({ projectDisplayName: event.target.value })} />
                </div>
                <div className="form-field">
                  <label htmlFor="settings-default-branch">Default branch</label>
                  <input id="settings-default-branch" value={editor.settings.defaultBranch ?? ''} onChange={(event) => updateSettings({ defaultBranch: event.target.value || null })} />
                </div>
                <div className="form-field">
                  <label htmlFor="settings-concurrency">Параллельные агенты проекта</label>
                  <input id="settings-concurrency" type="number" min={1} max={64} value={editor.settings.scheduler.concurrency} onChange={(event) => updateSettings({ scheduler: { ...editor.settings!.scheduler, concurrency: Number(event.target.value) || 1 } })} />
                </div>
                <label className="form-check"><input type="checkbox" checked={editor.settings.scheduler.enablePriorityAging} onChange={(event) => updateSettings({ scheduler: { ...editor.settings!.scheduler, enablePriorityAging: event.target.checked } })} /> Старение приоритета</label>
                <label className="form-check"><input type="checkbox" checked={editor.settings.scheduler.criticalPathBoost} onChange={(event) => updateSettings({ scheduler: { ...editor.settings!.scheduler, criticalPathBoost: event.target.checked } })} /> Повышение критического пути</label>
                <label className="form-check"><input type="checkbox" checked={editor.settings.recovery.resumeSessions} onChange={(event) => updateSettings({ recovery: { ...editor.settings!.recovery, resumeSessions: event.target.checked } })} /> Сначала возобновлять сессию Hermes</label>
                <div className="form-field">
                  <label htmlFor="settings-max-attempts">Попытки до эскалации</label>
                  <input id="settings-max-attempts" type="number" min={1} max={20} value={editor.settings.recovery.maxAttempts} onChange={(event) => updateSettings({ recovery: { ...editor.settings!.recovery, maxAttempts: Number(event.target.value) || 1 } })} />
                </div>
                <div className="form-field">
                  <label htmlFor="settings-recovery-cycle">Цикл восстановления (мин)</label>
                  <input id="settings-recovery-cycle" type="number" min={1} max={1440} value={editor.settings.recovery.recoveryCycleMinutes} onChange={(event) => updateSettings({ recovery: { ...editor.settings!.recovery, recoveryCycleMinutes: Number(event.target.value) || 30 } })} />
                </div>
                <div className="form-field">
                  <label htmlFor="settings-no-progress">Порог отсутствия прогресса (дней)</label>
                  <input id="settings-no-progress" type="number" min={1} max={90} value={editor.settings.recovery.abortOnNoProgressDays} onChange={(event) => updateSettings({ recovery: { ...editor.settings!.recovery, abortOnNoProgressDays: Number(event.target.value) || 2 } })} />
                </div>
                <label className="form-check"><input type="checkbox" checked={editor.settings.github.syncEnabled} onChange={(event) => updateSettings({ github: { ...editor.settings!.github, syncEnabled: event.target.checked } })} /> GitHub sync</label>
                <label className="form-check"><input type="checkbox" checked={editor.settings.github.issueLinking} onChange={(event) => updateSettings({ github: { ...editor.settings!.github, issueLinking: event.target.checked } })} /> Создавать Issues для задач</label>
                <label className="form-check"><input type="checkbox" checked={editor.settings.github.pullRequestSync} onChange={(event) => updateSettings({ github: { ...editor.settings!.github, pullRequestSync: event.target.checked } })} /> Сливать через GitHub PR</label>
              </div>
              <div className="top-actions" style={{ marginTop: '12px' }}>
                <button type="submit" className="btn-primary" disabled={candidateState.status === 'pending'}>Сохранить изменения</button>
              </div>
            </form>

            {savedCandidate && (
              <div className="reference-panel" aria-label="Сохранённый кандидат">
                <h3>Сохранённый кандидат</h3>
                <p>Статус: <strong>{savedCandidate.status}</strong> (активация только через exact-hash approval).</p>
                <p>Manifest hash кандидата: <code>{savedCandidate.manifestHash}</code></p>
                <div className="approval-diff">
                  {savedCandidate.diff.added.length > 0 && <div><strong>Добавлено</strong><span>{savedCandidate.diff.added.join(', ')}</span></div>}
                  {savedCandidate.diff.removed.length > 0 && <div><strong>Удалено</strong><span>{savedCandidate.diff.removed.join(', ')}</span></div>}
                  {savedCandidate.diff.modified.length > 0 && <div><strong>Изменено</strong><span>{savedCandidate.diff.modified.join(', ')}</span></div>}
                </div>
                <Link to="/approvals">Перейти к согласованию кандидата</Link>
              </div>
            )}
          </>
        )}
      </section>

      <section className="reference-panel" id="settings-budgets" aria-label="Бюджеты">
        <h2>Бюджеты</h2>
        <p>Политики бюджета редактируются через кандидат конфигурации проекта; активация — отдельным exact-hash согласованием.</p>
        <Link to="#settings-project-config">Перейти к редактору конфигурации</Link>
      </section>
      </div>
      </div>
    </div>
  );
}
