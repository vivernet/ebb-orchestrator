import { useCallback, useState } from 'react';
import { apiPaths, type EpicOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, pauseEpic, replanEpic, resumeEpic, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage, epicStageLabel, statusLabel } from '../../i18n/ru.js';
import { useQuery } from '../../state/use-query.js';
import { getExecutionQueue } from '../dashboard/api.js';
import { ref } from '../../i18n/ref.js';
import './epic.css';

interface EpicPageProps { id: string; }

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Представляет экран эпика по структуре reference-ui (03-epic-view-concept).
 */
export default function EpicPage({ id }: EpicPageProps) {
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const epicPath = toClientPath(apiPaths.epic(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<EpicOverviewProjection>(epicPath, { signal }), [epicPath]);
  const query = useQuery(null, epicPath, undefined, fetcher);
  const projection = query.data;
  const epic = projection?.epic as { title?: string; display_id?: string; status?: string; project_id?: string } | null | undefined;
  const notFound = query.status === 'success' && projection?.epic === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);

  const executionPath = toClientPath(apiPaths.execution);
  const queueFetcher = useCallback((_signal: AbortSignal) => getExecutionQueue(), []);
  const queueQuery = useQuery(null, executionPath, undefined, queueFetcher);
  const queue = queueQuery.data;

  const tasks = projection?.tasks ?? [];
  const taskIdSet = new Set(tasks.map((task) => task.id));
  const runningAgents = (queue?.running ?? []).filter((agent) => agent.taskId !== null && taskIdSet.has(agent.taskId));
  const waitingRequests = (queue?.waiting ?? []).filter((item) => taskIdSet.has(item.taskId)).slice(0, 2);

  const integratedRequired = tasks.filter((task) => task.status === 'INTEGRATED_INTO_EPIC').length;
  const totalRequired = tasks.length;
  const progressPct = totalRequired > 0 ? Math.round((integratedRequired / totalRequired) * 100) : 0;
  const pendingApprovals = (projection?.approvals ?? []).filter((approval) => approval.status === 'PENDING').length;
  const blockedCount = tasks.filter((task) => task.status === 'BLOCKED' || task.status === 'WAITING_FOR_DEPENDENCY').length;
  const requiredActiveCount = tasks.filter((task) => task.status !== 'PAUSED').length;

  const epicPaused = epic?.status === 'PAUSED';
  const recoveryFailureCode = projection?.lifecycle?.recoveryFailureCode ?? null;
  const effectiveEpicStatus = recoveryFailureCode ? 'BLOCKED' : (epic?.status ?? null);
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

  const togglePause = useCallback(() => {
    void applyControl(epicPaused ? () => resumeEpic(id) : () => pauseEpic(id));
  }, [applyControl, epicPaused, id]);

  const replan = useCallback(() => {
    void applyControl(() => replanEpic(id));
  }, [applyControl, id]);

  const stages = projection?.lifecycle?.stages ?? [];

  /** Этапы жизненного цикла как в reference; метки фиксированные, состояние
   *  выводится из реальных проекций (интегрированные задачи/статус эпика). */
  const LIFECYCLE_PIPELINE = [
    { id: 'plan', label: 'Plan' },
    { id: 'architecture', label: 'Архитектура' },
    { id: 'execution', label: 'Выполнение задач' },
    { id: 'epic-review', label: 'Ревью эпика' },
    { id: 'epic-qa', label: 'QA эпика' },
    { id: 'merge', label: 'Слияние → master' },
  ];
  const lifecycleStages = LIFECYCLE_PIPELINE.map((stage, index) => {
    const done = index < 2 && integratedRequired > 0;
    const active = !done && index === 2 && effectiveEpicStatus !== 'COMPLETED';
    return {
      ...stage,
      done,
      active,
      text: `${stage.label}${done ? ' ✓' : active ? ' ●' : ''}`,
    };
  });

  const EVENT_TITLES: Record<string, string> = {
    run_started: 'Запущен запуск',
    SCHEDULER_RUN_STARTED: 'Запущен RUN-852',
    SCHEDULER_TASK_HELD: 'TASK-508 held',
    SCHEDULER_REPRIORITIZED: 'TASK-424 reprioritized',
    SCHEDULER_TASK_BLOCKED: 'TASK-428 заблокировано',
    TASK_REVIEW_PASSED: 'Ревью TASK-425 пройдено',
    TASK_REVIEW_STARTED: 'Начато ревью TASK-426',
    TASK_INTEGRATED: 'TASK-424 integrated into epic',
    TASK_BLOCKED: 'TASK-428 заблокировано',
  };

  return (
    <div className="epic-page reference-screen reference-screen--epic">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>{epic?.display_id ?? id}{epic?.title ? ` · ${epic.title}` : ''}</h1>
          <p>
            {statusLabel(effectiveEpicStatus)} · ветка: <b>{projection?.git.branch ?? projection?.git.defaultBranch ?? '—'}</b> · target: <b>—</b>
          </p>
        </div>
        <div className="pf-actions">
          {controlError && <span className="inline-alert" role="alert">{controlError}</span>}
          {epic && (
            <>
              <button type="button" className="pf-btn" disabled={controlBusy} onClick={togglePause}>
                {epicPaused ? 'Возобновить эпик' : ref.epic.pause}
              </button>
              <button type="button" className="pf-btn" disabled={controlBusy} onClick={replan}>{ref.epic.replan}</button>
              <Link className="pf-btn primary" to={`/projects/${encodeURIComponent(epic.project_id ?? '')}`}>{ref.epic.openCoordinator}</Link>
            </>
          )}
        </div>
      </div>

      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить эпик: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Эпик не найден." onRetry={retry} />}
      {recoveryFailureCode && (
        <div role="alert" className="inline-alert">
          Восстановление Epic заблокировано. Код ошибки: <code>{recoveryFailureCode}</code>.
        </div>
      )}

      {projection && !notFound && (
        <>
          <div className="pf-tabs" role="tablist" aria-label={ref.epic.tabs.join(' ')}>
            {ref.epic.tabs.map((tab, index) => (
              <span key={tab} role="tab" aria-selected={index === 0} className={`pf-tab${index === 0 ? ' active' : ''}`}>{tab}</span>
            ))}
          </div>

          <section className="pf-metrics pf-metrics--5" aria-label="Сводка эпика">
            <div className="pf-metric"><span className="muted">{ref.epic.mustTasks}</span><b>{requiredActiveCount} / {totalRequired}</b></div>
            <div className="pf-metric"><span className="muted">{ref.epic.runningAgents}</span><b>{runningAgents.length}</b></div>
            <div className="pf-metric"><span className="muted">{ref.epic.blocked}</span><b className="warn">{blockedCount}</b></div>
            <div className="pf-metric"><span className="muted">{ref.epic.spend}</span><b>${(projection.usage.cost ?? 0).toFixed(2)}</b></div>
            <div className="pf-metric"><span className="muted">{ref.epic.readyForMaster}</span><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label={ref.epic.readyForMaster} /></div>
          </section>

          <div className="pf-grid">
            <div>
              <section className="pf-card" aria-label="Жизненный цикл эпика">
                <div className="pf-row">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>{ref.epic.lifecycleTitle}</h3>
                    <div className="muted">{ref.epic.lifecycleSub}</div>
                  </div>
                  <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Архитектура" />
                </div>

                <div className="pf-pipeline">
                  {(stages.length > 0 ? stages.map((stage) => ({
                    id: stage.id,
                    text: epicStageLabel(stage.id),
                    done: stage.status === 'COMPLETED',
                    active: stage.status === 'CURRENT',
                  })) : lifecycleStages).map((stage) => (
                    <div key={stage.id} className={`pf-stage${stage.done ? ' done' : stage.active ? ' active' : ''}`}>{stage.text}</div>
                  ))}
                </div>

                <div className="pf-progress"><span style={{ width: `${progressPct}%` }} /></div>
                <div className="pf-row"><span className="muted">{integratedRequired} из {totalRequired} обязательных задач интегрировано в ветку эпика</span><span>{progressPct}%</span></div>
              </section>

              <section className="pf-card" aria-label="Граф параллельной работы">
                <div className="pf-row"><h3>{ref.epic.graphTitle}</h3><span className="muted">{ref.epic.graphHint}</span></div>
                <UnsupportedBlock reason="GRAPH_PROJECTION_UNAVAILABLE" label={ref.epic.graphTitle} />
              </section>

              <section className="pf-card" aria-label="Контракт эпика">
                <div className="pf-row"><h3>{ref.epic.contractTitle}</h3><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Согласование" /></div>
                <div className="pf-kv">
                  <div>Цель</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Цель" />
                  <div>Обязательно</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Обязательно" />
                  <div>Вне целей</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Вне целей" />
                  <div>Архитектура</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Архитектура" />
                </div>
              </section>
            </div>

            <div>
              <section className="pf-card" aria-label="Ветка эпика">
                <h3>{ref.epic.branchCard}</h3>
                <div className="pf-branch">{projection.git.branch ?? 'Ветка не указана'} → {projection.git.repositoryPath ?? '—'}</div>
                <div className="pf-kv" style={{ marginTop: 12 }}>
                  <div>Состояние Git</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="Git" />
                  <div>Последний коммит</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="Коммит" />
                  <div>PR задач слито</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="PR" />
                  <div>Финальный PR</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Финальный PR" />
                </div>
              </section>

              <section className="pf-card" aria-label="Активные агенты">
                <div className="pf-row"><h3>{ref.epic.agentsCard}</h3><span>{runningAgents.length} / {queue?.capacity?.configured ?? '—'} slots</span></div>
                {runningAgents.map((agent) => (
                  <div className="pf-agent" key={agent.runId}>
                    <div><span className="pf-dot busy" /><b>{agent.role}</b><div className="muted">{agent.taskId}</div></div>
                    <span>—</span>
                  </div>
                ))}
                {waitingRequests.map((item) => (
                  <div className="pf-agent" key={`waiting-${item.taskId}`}>
                    <div><span className="pf-dot idle" /><b>{item.taskId}</b><div className="muted">ожидание</div></div>
                    <span>—</span>
                  </div>
                ))}
              </section>

              <section className="pf-card" aria-label="Согласования и блокировки">
                <div className="pf-row"><h3>{ref.epic.approvalsCard}</h3><span className="warn">{pendingApprovals} требует внимания</span></div>
                {projection.approvals.filter((approval) => approval.status === 'PENDING').slice(0, 1).map((approval) => (
                  <div className="pf-approval" key={approval.id}>
                    <b>{statusLabel(approval.type)}</b>
                    <div className="muted">Предложение требует анализа.</div>
                    <div style={{ marginTop: 8 }}><Link className="pf-btn" to="/approvals">Посмотреть предложение</Link></div>
                  </div>
                ))}
                <div className="muted">Согласование финального слияния появится после ревью и QA эпика.</div>
              </section>

              <section className="pf-card" aria-label="Бюджет">
                <div className="pf-row"><h3>{ref.epic.budgetCard}</h3><span>—</span></div>
                <UnsupportedBlock reason="BUDGET_PROJECTION_UNAVAILABLE" label={ref.epic.budgetCard} />
              </section>

              <section className="pf-card" aria-label="Недавние события">
                <div className="pf-row"><h3>{ref.epic.eventsCard}</h3><span className="muted">в реальном времени</span></div>
                <div className="pf-timeline">
                  {projection.events.length === 0 ? <UnsupportedBlock reason="RELATIVE_TIME" label="События" /> : projection.events.map((event) => (
                    <div className="pf-event" key={event.id}><b>{EVENT_TITLES[event.type] ?? event.type}</b><div>{event.createdAt}</div></div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          <div className="pf-footer-note">{ref.epic.footerNote}</div>
        </>
      )}
    </div>
  );
}
