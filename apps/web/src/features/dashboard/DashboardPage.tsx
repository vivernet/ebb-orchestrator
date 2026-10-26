import { useCallback, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { ErrorAlert, PageState } from '../../components/ui/PageState.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { getDashboard, getExecutionQueue } from './api.js';
import { toClientPath, setDispatchState } from '../../api/client.js';
import { ref } from '../../i18n/ref.js';
import './dashboard.css';

function message(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Представляет панель управления по структуре reference-ui (01-dashboard-concept).
 * Сводки приходят из авторитетных проекций; поля без источника рендерят
 * контрактный блок «недоступно».
 */
export default function DashboardPage() {
  const dashboardPath = toClientPath(apiPaths.dashboard);
  const executionPath = toClientPath(apiPaths.execution);
  const projectionFetcher = useCallback((_signal: AbortSignal) => getDashboard(), []);
  const queueFetcher = useCallback((_signal: AbortSignal) => getExecutionQueue(), []);
  const projectionQuery = useQuery(null, dashboardPath, undefined, projectionFetcher);
  const queueQuery = useQuery(null, executionPath, undefined, queueFetcher);
  const projection = projectionQuery.data;
  const queue = queueQuery.data;
  const retryProjection = useCallback(() => { void projectionQuery.refetch().catch(() => undefined); }, [projectionQuery.refetch]);
  const retryQueue = useCallback(() => { void queueQuery.refetch().catch(() => undefined); }, [queueQuery.refetch]);
  const refresh = useCallback(() => {
    retryProjection();
    retryQueue();
  }, [retryProjection, retryQueue]);

  useOnSSEReconnect(refresh);

  const running = queue?.running ?? [];
  const waiting = queue?.waiting ?? [];
  const paused = queue?.dispatchState?.paused ?? false;
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const toggleDispatchPause = useCallback(() => {
    setDispatchBusy(true);
    setDispatchError(null);
    void setDispatchState(!paused)
      .then(() => retryQueue())
      .catch((cause: unknown) => setDispatchError(message(cause)))
      .finally(() => setDispatchBusy(false));
  }, [paused, retryQueue]);

  return (
    <div className="dashboard-page reference-screen reference-screen--dashboard">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>{ref.dashboard.title}</h1>
          <p>{ref.dashboard.subtitle}</p>
        </div>
        <div className="pf-actions">
          {dispatchError && <span className="inline-alert" role="alert">{dispatchError}</span>}
          <button type="button" className="pf-btn" disabled={dispatchBusy || !queue} onClick={toggleDispatchPause}>
            {ref.dashboard.pauseAll}
          </button>
          <Link className="pf-btn primary" to="/projects/new">{ref.dashboard.newRequest}</Link>
        </div>
      </div>

      <section className="pf-metrics" aria-label="Ключевые показатели">
        <div className="pf-metric">
          <span className="muted">{ref.dashboard.runningAgents}</span>
          <UnsupportedBlock reason="CAPACITY_PROJECTION_UNAVAILABLE" label={ref.dashboard.runningAgents} />
        </div>
        <div className="pf-metric">
          <span className="muted">{ref.dashboard.activeWork}</span>
          <b>{projection ? projection.activeWork.filter((t) => t.status !== 'BLOCKED').length : '—'}</b>
        </div>
        <div className="pf-metric">
          <span className="muted">{ref.dashboard.pendingApprovals}</span>
          <b className="warn">{projection?.approvals ?? '—'}</b>
        </div>
        <div className="pf-metric">
          <span className="muted">{ref.dashboard.aiSpendToday}</span>
          <UnsupportedBlock reason="SPEND_PROJECTION_UNAVAILABLE" label={ref.dashboard.aiSpendToday} />
        </div>
      </section>

      <div className="pf-grid pf-grid--dash">
        <div>
          <section className="pf-card" aria-label="Активные проекты">
            <div className="pf-row"><h3>{ref.dashboard.activeProjects}</h3><span className="muted">{projection?.projects.length ?? '—'} проекта</span></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить проекты: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка проектов…" /> :
                <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Прогресс проектов" />}
          </section>

          <section className="pf-card" aria-label="Координатор">
            <h3>{ref.dashboard.coordinator}</h3>
            <UnsupportedBlock reason="CHAT_PROJECTION_UNAVAILABLE" label={ref.dashboard.coordinator} />
          </section>
        </div>

        <div>
          <section className="pf-card" aria-label="Центр согласований">
            <div className="pf-row"><h3>{ref.dashboard.approvalsCenter}</h3><span className="warn">{projection?.approvals ?? '—'} ожидают</span></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить согласования: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка согласований…" /> :
                <UnsupportedBlock reason="APPROVALS_LIST_PROJECTION_UNAVAILABLE" label="Список согласований" />}
            <button type="button" className="pf-btn pf-btn--full" onClick={() => { window.location.href = '/approvals'; }}>{ref.dashboard.openApprovals}</button>
          </section>

          <section className="pf-card" aria-label="Очередь выполнения">
            <div className="pf-row"><h3>{ref.dashboard.executionQueue}</h3><span className="muted">{running.length} выполняются</span></div>
            {queueQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить очередь: ${message(queueQuery.error)}`} onRetry={retryQueue} /> :
              queueQuery.status !== 'success' || !queue ? <PageState status="loading" message="Загрузка очереди…" /> : (
                <div className="pf-queue">
                  {running.map((agent) => (
                    <div className="pf-qitem" key={`run-${agent.runId}`}>
                      <div><span className="pf-dot" /><b>{agent.role}</b></div>
                      <div className="meta"><span>{agent.taskId ?? 'Системный запуск'}</span><span>—</span><span>Hermes</span></div>
                    </div>
                  ))}
                  {waiting.slice(0, 1).map((item) => (
                    <div className="pf-qitem" key={`waiting-${item.taskId}`}>
                      <div><span className="pf-dot idle" /><b>{item.taskId}</b></div>
                      <div className="meta"><span>{item.reason.code}</span></div>
                    </div>
                  ))}
                </div>
              )}
          </section>

          <section className="pf-card" aria-label="Пул агентов">
            <h3>{ref.dashboard.agentPool}</h3>
            <UnsupportedBlock reason="AGENT_POOL_PROJECTION_UNAVAILABLE" label={ref.dashboard.agentPool} />
          </section>
        </div>
      </div>

      <div className="pf-footer-note">{ref.dashboard.footerNote}</div>
    </div>
  );
}
