import { useCallback } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import ChatPanel from '../chat/ChatPanel.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, waitReasonLabel } from '../../i18n/ru.js';
import { getDashboard, getExecutionQueue } from './api.js';
import { toClientPath } from '../../api/client.js';

function message(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Представляет сводные данные backend без локальных оценок мощности или переходов workflow.
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

  const projects = projection?.projects ?? [];
  const firstProject = projects[0];
  const waiting = queue?.waiting ?? [];
  const blocked = queue?.blocked ?? [];
  const running = queue?.running ?? [];

  return (
    <div className="dashboard-page reference-screen reference-screen--dashboard">
      <header className="reference-heading">
        <div>
          <h1>Обзор</h1>
          <p>Текущее состояние проектов и выполнения — из актуальных проекций системы.</p>
        </div>
      </header>

      <section className="reference-metrics" aria-label="Ключевые показатели">
        {projectionQuery.status === 'success' && projection ? (
          <>
            <div className="reference-metric"><span>Активные агенты</span><strong>{projection.activeAgents.length}</strong></div>
            <div className="reference-metric"><span>Активная работа</span><strong>{projection.activeWork.length}</strong></div>
            <div className="reference-metric"><span>Ожидают согласования</span><strong>{projection.approvals}</strong></div>
            <div className="reference-metric"><span>Использование</span><strong>{projection.usage.totalTokens.toLocaleString('ru-RU')} токенов</strong><small>${projection.usage.cost.toFixed(2)}</small></div>
          </>
        ) : projectionQuery.status === 'error' ? (
          <ErrorAlert message={`Не удалось загрузить сводные показатели: ${message(projectionQuery.error)}`} onRetry={retryProjection} />
        ) : <PageState status="loading" message="Загрузка сводных показателей…" />}
      </section>

      <div className="reference-columns dashboard-columns">
        <div className="reference-column">
          <section className="reference-panel" aria-label="Активные проекты">
            <div className="section-heading"><h2>Активные проекты</h2><Link to="/projects">Все проекты</Link></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить проекты: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка проектов…" /> :
                projection.projects.length === 0 ? <EmptyState message="Нет проектов в обзоре. Добавьте проект через онбординг." /> : (
                  <ul className="reference-record-list">
                    {projection.projects.map((project) => (
                      <li key={project.id}>
                        <Link to={`/projects/${encodeURIComponent(project.id)}`}>
                          <strong>{project.displayName || project.name}</strong>
                          <span><StatusBadge status={project.status} /></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
          </section>

          <section className="reference-panel" aria-label="Активная работа">
            <div className="section-heading"><h2>Активная работа</h2><span>{projection?.activeWork.length ?? '—'}</span></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить активную работу: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка активной работы…" /> :
                projection.activeWork.length === 0 ? <EmptyState message="Нет активной работы." /> : (
                  <ul className="reference-record-list">
                    {projection.activeWork.map((work) => (
                      <li key={work.id}>
                        <Link to={`/tasks/${encodeURIComponent(work.id)}`}>
                          <strong>{work.title || work.id}</strong>
                          <span><StatusBadge status={work.status} />{work.eligibility.status === 'BLOCK' && ` · ${waitReasonLabel(work.eligibility.reason.code)}`}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
          </section>

        </div>

        <div className="reference-column">
          <section className="reference-panel" aria-label="Центр согласований">
            <div className="section-heading"><h2>Центр согласований</h2><Link to="/approvals">Открыть очередь</Link></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить число согласований: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка согласований…" /> :
                projection.approvals === 0 ? <EmptyState message="Ожидающих согласований нет." /> :
                  <p className="reference-callout">{projection.approvals} запросов требуют решения человека.</p>}
          </section>

          <section className="reference-panel" aria-label="Очередь выполнения">
            <div className="section-heading"><h2>Очередь выполнения</h2><Link to="/execution">Монитор</Link></div>
            {queueQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить очередь: ${message(queueQuery.error)}`} onRetry={retryQueue} /> :
              queueQuery.status !== 'success' || !queue ? <PageState status="loading" message="Загрузка очереди…" /> : (
                <>
                  <div className="queue-counts" aria-label="Состояние очереди">
                    <span><strong>{running.length}</strong> выполняется</span>
                    <span><strong>{waiting.length}</strong> ожидает</span>
                    <span><strong>{blocked.length}</strong> заблокировано</span>
                  </div>
                  {running.length + waiting.length + blocked.length === 0 ? <EmptyState message="Очередь пуста." /> : (
                    <ul className="reference-record-list">
                      {running.map((agent) => (
                        <li key={`run-${agent.runId}`}>
                          <Link to={`/runs/${encodeURIComponent(agent.runId)}`}>
                            <strong>{agent.role}</strong><span>{agent.taskId ?? 'Системный запуск'} · <StatusBadge status={agent.status} /></span>
                          </Link>
                        </li>
                      ))}
                      {waiting.map((item) => (
                        <li key={`waiting-${item.taskId}`}>
                          <Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>
                            <strong>{item.taskId}</strong><span>{waitReasonLabel(item.reason.code)}</span>
                          </Link>
                        </li>
                      ))}
                      {blocked.map((item) => (
                        <li key={`blocked-${item.taskId}`}>
                          <Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>
                            <strong>{item.taskId}</strong><span>{waitReasonLabel(item.reason.code)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
          </section>

          <section className="reference-panel" aria-label="Пул агентов">
            <div className="section-heading"><h2>Пул агентов</h2><span>{projection?.activeAgents.length ?? '—'} активных</span></div>
            {projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить активных агентов: ${message(projectionQuery.error)}`} onRetry={retryProjection} /> :
              projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка агентов…" /> :
                projection.activeAgents.length === 0 ? <EmptyState message="Сейчас нет работающих агентов." /> : (
                  <ul className="reference-record-list">
                    {projection.activeAgents.map((agent) => (
                      <li key={agent.runId}>
                        <Link to={`/runs/${encodeURIComponent(agent.runId)}`}>
                          <strong>{agent.role}</strong><span><StatusBadge status={agent.status} /></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
          </section>
        </div>

        <section className="reference-panel dashboard-chat-panel" aria-label="Координатор">
          <div className="section-heading"><h2>Координатор</h2><p>Обсуждение работы проекта</p></div>
          <ChatPanel projectId={firstProject?.id ?? null} />
        </section>
      </div>
    </div>
  );
}
