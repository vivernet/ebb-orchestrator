import { useCallback, useState } from 'react';
import { apiPaths, type TaskOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, pauseTask, resumeTask, setTaskPriority, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { useQuery } from '../../state/use-query.js';
import { ref } from '../../i18n/ref.js';
import './task.css';

interface TaskPageProps { id?: string; }

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/** Короткие подписи состояний (как в reference). */
function shortRunStatus(status: string | null | undefined): string {
  switch (status) {
    case 'COMPLETED': return 'завершён';
    case 'FAILED': return 'ошибка';
    case 'CANCELLED': return 'отменён';
    case 'IN_PROGRESS': case 'STARTED': return 'выполняется';
    default: return status ?? '—';
  }
}

/** Индекс активного этапа процесса задачи по фактическому статусу. */
function pipelineIndex(status: string | null | undefined): number {
  switch (status) {
    case 'READY': case 'DEV': case 'DEVELOPMENT': return 0;
    case 'REVIEW': return 1;
    case 'QA': return 2;
    case 'READY_FOR_INTEGRATION': case 'INTEGRATION': return 3;
    case 'DONE': case 'RELEASED': return 4;
    default: return status === 'BLOCKED' || status === 'PAUSED' ? 2 : 0;
  }
}

const PIPELINE_STAGES = ['Development', 'Review', 'QA', 'Integration', 'Ветка эпика'];

/**
 * Представляет экран задачи по структуре reference-ui (02-task-view-concept).
 */
export default function TaskPage({ id = '' }: TaskPageProps) {
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [priorityValue, setPriorityValue] = useState('50');
  const taskPath = toClientPath(apiPaths.task(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<TaskOverviewProjection>(taskPath, { signal }), [taskPath]);
  const query = useQuery(null, taskPath, undefined, fetcher, { enabled: Boolean(id) });
  const projection = query.data;
  const task = projection?.task as { title?: string; display_id?: string; status?: string; project_id?: string; epic_id?: string | null } | null | undefined;
  const notFound = query.status === 'success' && projection?.task === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);

  const isPaused = projection?.lifecycle?.status === 'PAUSED'
    || (projection?.scheduler?.status === 'WAIT' && projection.scheduler.reason?.code === 'WAITING_FOR_PAUSE');

  const applyControl = useCallback(async (action: () => Promise<unknown>) => {
    setControlBusy(true);
    setControlError(null);
    try {
      await action();
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      setControlError(errorMessage(cause));
    } finally {
      setControlBusy(false);
    }
  }, [query.refetch]);

  const resume = useCallback(() => {
    void applyControl(() => resumeTask(id));
  }, [applyControl, id]);

  const pause = useCallback(() => {
    void applyControl(() => pauseTask(id));
  }, [applyControl, id]);

  const applyPriority = useCallback(() => {
    const priority = Number(priorityValue);
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) return;
    void applyControl(() => setTaskPriority(id, priority));
  }, [applyControl, id, priorityValue]);

  const runs = projection?.runs ?? [];
  const activeRun = runs.find((run) => run.status === 'IN_PROGRESS' || run.status === 'STARTED') ?? null;
  const stageIndex = pipelineIndex(projection?.lifecycle?.status ?? task?.status);

  return (
    <div className="task-page reference-screen reference-screen--task">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>{task?.display_id ?? id}{task?.title ? ` · ${task.title}` : ''}</h1>
          <p>
            {task?.project_id ? `Проект ${task.project_id} · ` : ''}
            {task?.epic_id ? `EPIC ${task.epic_id} · ` : ''}
            назначен: <b>{activeRun?.role ?? '—'}</b> · target: <b>—</b>
          </p>
        </div>
        <div className="pf-actions">
          {controlError && <span className="inline-alert" role="alert">{`Не удалось изменить задачу: ${controlError}`}</span>}
          {projection && !notFound && (
            <>
              {isPaused ? (
                <button type="button" className="pf-btn" disabled={controlBusy} onClick={resume}>{ref.task.resume}</button>
              ) : (
                <button type="button" className="pf-btn" disabled={controlBusy} onClick={pause}>{ref.task.pause}</button>
              )}
              <button type="button" className="pf-btn" onClick={() => setPriorityOpen((open) => !open)}>{ref.task.priority}</button>
              <Link className="pf-btn primary" to={projection.git.worktreePath ? `file://${encodeURIComponent(projection.git.worktreePath)}` : '/tasks'}>
                {ref.task.openWorktree}
              </Link>
            </>
          )}
        </div>
      </div>

      {priorityOpen && projection && !notFound && (
        <div className="pf-row" style={{ marginBottom: 12 }}>
          <label htmlFor="task-priority">Приоритет задачи</label>
          <input id="task-priority" type="number" min={1} max={1000} value={priorityValue}
            onChange={(event) => setPriorityValue(event.target.value)} />
          <button type="button" className="pf-btn" disabled={controlBusy} onClick={applyPriority}>Применить приоритет</button>
        </div>
      )}

      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить задачу: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Задача не найдена." onRetry={retry} />}

      {projection && !notFound && (
        <>
          <div className="pf-tabs" role="tablist" aria-label={ref.task.tabs.join(' ')}>
            {ref.task.tabs.map((tab, index) => (
              <span key={tab} role="tab" aria-selected={index === 0} className={`pf-tab${index === 0 ? ' active' : ''}`}>{tab}</span>
            ))}
          </div>

          <section className="pf-metrics pf-metrics--5" aria-label="Сводка задачи">
            <div className="pf-metric"><span className="muted">{ref.task.statusMetric}</span><b>{projection.lifecycle.status ?? task?.status ?? '—'}</b></div>
            <div className="pf-metric"><span className="muted">{ref.task.priorityMetric}</span><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label={ref.task.priorityMetric} /></div>
            <div className="pf-metric"><span className="muted">{ref.task.attemptMetric}</span><b>{runs.length > 0 ? 1 : 0}</b></div>
            <div className="pf-metric"><span className="muted">{ref.task.spendMetric}</span><b>${(projection.usage.cost ?? 0).toFixed(2)}</b></div>
            <div className="pf-metric">
              <span className="muted">{ref.task.blockedMetric}</span>
              <b className={projection.scheduler.status === 'BLOCK' ? 'warn' : 'good'}>{projection.scheduler.status === 'BLOCK' ? 'Да' : 'Нет'}</b>
            </div>
          </section>

          <div className="pf-grid">
            <div>
              <section className="pf-card" aria-label="Процесс задачи">
                <div className="pf-row"><h3>{ref.task.process}</h3><span className="pf-chip">{ref.task.processChip}</span></div>
                <div className="pf-pipeline pf-pipeline--5">
                  {PIPELINE_STAGES.map((stage, index) => {
                    const stateClass = index < stageIndex ? ' done' : index === stageIndex ? ' active' : ' wait';
                    return <div key={stage} className={`pf-stage${stateClass}`}>{stage}{index < stageIndex ? ' ✓' : index === stageIndex ? ' ●' : ''}</div>;
                  })}
                </div>
              </section>

              <section className="pf-card" aria-label="Контракт задачи">
                <div className="pf-row"><h3>{ref.task.contractTitle}</h3><span className="pf-chip">{ref.task.contractChip}</span></div>
                <div className="pf-contract">
                  <div className="pf-block"><strong>Цель</strong><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Цель" /></div>
                  <div className="pf-block"><strong>Требования</strong><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Требования" /></div>
                  <div className="pf-block"><strong>Критерии приёмки</strong><UnsupportedBlock reason="ACCEPTANCE_PROJECTION_UNAVAILABLE" label="Критерии приёмки" /></div>
                  <div className="pf-block"><strong>Вне целей</strong><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Вне целей" /></div>
                </div>
              </section>

              <section className="pf-card" aria-label="Запуски агентов">
                <div className="pf-row"><h3>{ref.task.runsTitle}</h3><span className="muted">{runs.length} запуска</span></div>
                {runs.length === 0 ? <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Запуски" /> : runs.map((run) => {
                  const rework = run.role === 'Reviewer' || String(run.role).toLowerCase().includes('reviewer');
                  return (
                    <div className="pf-run" key={run.id}>
                      <div className="kind">{run.id}<br />{run.role}</div>
                      <div><b>{run.role}</b><small><Link to={`/runs/${encodeURIComponent(run.id)}`}>смотреть запуск</Link></small></div>
                      <span className={`pf-chip${run.status === 'COMPLETED' ? ' good' : run.status === 'IN_PROGRESS' ? ' warn' : ''}`}>
                        {rework ? 'доработка' : shortRunStatus(run.status)}
                      </span>
                    </div>
                  );
                })}
              </section>

              <section className="pf-card" aria-label="Проверка результатов">
                <div className="pf-row"><h3>{ref.task.findingsTitle}</h3><span className="good">{ref.task.findingsStatus}</span></div>
                <UnsupportedBlock reason="FINDINGS_PROJECTION_UNAVAILABLE" label={ref.task.findingsTitle} />
              </section>
            </div>

            <div>
              <section className="pf-card" aria-label="Git">
                <h3>{ref.task.gitCard}</h3>
                <div className="pf-branch">{projection.git.branch ?? 'Ветка не указана'}</div>
                <div className="pf-kv" style={{ marginTop: 12 }}>
                  <div>Worktree</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="Worktree" />
                  <div>HEAD</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="HEAD" />
                  <div>Base</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="Base" />
                </div>
              </section>

              <section className="pf-card" aria-label="Текущий агент">
                <div className="pf-row"><h3>{ref.task.currentAgent}</h3><span className="pf-chip">{activeRun?.id ?? '—'}</span></div>
                {activeRun ? (
                  <>
                    <div><span className="pf-dot busy" /><b>{activeRun.role}</b></div>
                    <div className="muted" style={{ marginTop: 6 }}>Hermes · локальное выполнение</div>
                    <UnsupportedBlock reason="PROGRESS_PROJECTION_UNAVAILABLE" label="Прогресс" />
                  </>
                ) : <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Текущий агент" />}
              </section>

              <section className="pf-card" aria-label="Восстановление">
                <div className="pf-row"><h3>{ref.task.recovery}</h3><span className="good">{ref.task.recoveryOk}</span></div>
                <UnsupportedBlock reason="RECOVERY_PROJECTION_UNAVAILABLE" label={ref.task.recovery} />
              </section>

              <section className="pf-card" aria-label="Использование">
                <div className="pf-row"><h3>{ref.task.usageCard}</h3><span>${(projection.usage.cost ?? 0).toFixed(2)}</span></div>
                <UnsupportedBlock reason="TASK_USAGE_PROJECTION_UNAVAILABLE" label={ref.task.usageCard} />
              </section>

              <section className="pf-card" aria-label="Dependencies">
                <div className="pf-row"><h3>{ref.task.dependenciesCard}</h3><span className="good">{ref.task.dependenciesOk}</span></div>
                <UnsupportedBlock reason="DEPENDENCY_GRAPH_PROJECTION_UNAVAILABLE" label={ref.task.dependenciesCard} />
              </section>

              <section className="pf-card" aria-label="Недавние события">
                <div className="pf-row"><h3>{ref.task.eventsCard}</h3><span className="muted">в реальном времени</span></div>
                <div className="pf-timeline">
                  {projection.events.length === 0 ? <UnsupportedBlock reason="RELATIVE_TIME" label="События" /> : projection.events.map((event) => (
                    <div className="pf-event" key={event.id}><b>{event.type}</b><div>{event.createdAt}</div></div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <div className="pf-footer-note">{ref.task.footerNote}</div>
        </>
      )}
    </div>
  );
}
