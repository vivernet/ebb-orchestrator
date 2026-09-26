import { useCallback } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, waitReasonLabel } from '../../i18n/ru.js';
import { getDashboard, getExecutionQueue } from './api.js';
import { toClientPath } from '../../api/client.js';

function message(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Представляет пользовательский экран DashboardPage; авторитетные проверки выполняются backend.
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

  return (
    <div className="dashboard-page">
      <h1>Обзор</h1>
      <section aria-label="Работающие агенты"><h2>Работающие агенты</h2>{projectionQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить обзор: ${message(projectionQuery.error)}`} /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка обзора…" /> : projection.activeAgents.length === 0 ? <EmptyState message="Нет работающих агентов." /> : <><p>{projection.activeAgents.length} активных агентов</p><ul>{projection.activeAgents.map((agent) => <li key={agent.runId}><Link to={`/runs/${encodeURIComponent(agent.runId)}`}>{agent.role} · <StatusBadge status={agent.status} /></Link></li>)}</ul></>}</section>
      <section aria-label="Активная работа"><h2>Активная работа</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Данные обзора недоступны." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка обзора…" /> : projection.activeWork.length === 0 ? <EmptyState message="Нет активной работы." /> : <><p>{projection.activeWork.length} элементов работы</p><ul>{projection.activeWork.map((work) => <li key={work.id}><Link to={`/tasks/${encodeURIComponent(work.id)}`}>{work.title || work.id} · <StatusBadge status={work.status} />{work.eligibility.status === 'BLOCK' && <span> · {waitReasonLabel(work.eligibility.reason.code)}</span>}</Link></li>)}</ul></>}</section>
      <section aria-label="Требуют согласования"><h2>Требуют согласования</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Данные обзора недоступны." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка обзора…" /> : <p>{projection.approvals} ожидающих согласования</p>}</section>
      <section aria-label="Расходы на ИИ"><h2>Расходы на ИИ</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Данные обзора недоступны." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка обзора…" /> : <p>{projection.usage.totalTokens} токенов · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Активные проекты"><h2>Активные проекты</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Данные обзора недоступны." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Загрузка обзора…" /> : projection.projects.length === 0 ? <EmptyState message="Нет активных проектов." /> : <ul>{projection.projects.map((project) => <li key={project.id}><Link to={`/projects/${encodeURIComponent(project.id)}`}>{project.displayName || project.name} · <StatusBadge status={project.status} /></Link></li>)}</ul>}</section>
      <section aria-label="Очередь"><h2>Очередь</h2>{queueQuery.status === 'error' ? <ErrorAlert message={`Не удалось загрузить очередь: ${message(queueQuery.error)}`} onRetry={retryQueue} /> : queueQuery.status !== 'success' || !queue ? <PageState status="loading" message="Загрузка очереди…" /> : queue.waiting.length === 0 && queue.blocked.length === 0 ? <EmptyState message="Очередь пуста." /> : <><p>{`Ожидает: ${queue.waiting.length}, заблокировано: ${queue.blocked.length}`}</p><ul>{queue.waiting.map((item) => <li key={`waiting-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {waitReasonLabel(item.reason.code)}</li>)}{queue.blocked.map((item) => <li key={`blocked-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {waitReasonLabel(item.reason.code)}</li>)}</ul></>}</section>
      <section aria-label="Сводка согласований"><h2>Сводка согласований</h2>{projectionQuery.status === 'success' && projection && <p>{projection.approvals} согласований требуют внимания.</p>}</section>
      <section aria-label="Пул агентов"><h2>Пул агентов</h2>{projectionQuery.status === 'success' && projection && <p>{projection.activeAgents.length} активных агентов в доступном пуле.</p>}</section>
      {projectionQuery.status === 'error' && <button type="button" onClick={retryProjection}>Повторить</button>}
    </div>
  );
}
