import { useCallback, useMemo } from 'react';
import { apiPaths, type DashboardProjection, type ExecutionQueueProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/PageState.js';
import StatusBadge from '../../components/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Представляет пользовательский экран DashboardPage; авторитетные проверки выполняются backend.
 */
export default function DashboardPage() {
  const store = useMemo(() => createQueryStore(), []);
  const dashboardPath = toClientPath(apiPaths.dashboard);
  const executionPath = toClientPath(apiPaths.execution);
  const projectionFetcher = useCallback((signal: AbortSignal) => apiClient.get<DashboardProjection>(dashboardPath, { signal }), [dashboardPath]);
  const queueFetcher = useCallback((signal: AbortSignal) => apiClient.get<ExecutionQueueProjection>(executionPath, { signal }), [executionPath]);
  const projectionQuery = useQuery(store, dashboardPath, undefined, projectionFetcher);
  const queueQuery = useQuery(store, executionPath, undefined, queueFetcher);
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
      <h1>Dashboard</h1>
      <section aria-label="Running agents"><h2>Running agents</h2>{projectionQuery.status === 'error' ? <ErrorAlert message={`Unable to load dashboard: ${message(projectionQuery.error)}`} /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Loading dashboard…" /> : projection.activeAgents.length === 0 ? <EmptyState message="No running agents." /> : <><p>{projection.activeAgents.length} active agent{projection.activeAgents.length === 1 ? '' : 's'}</p><ul>{projection.activeAgents.map((agent) => <li key={agent.runId}><Link to={`/runs/${encodeURIComponent(agent.runId)}`}>{agent.role} · <StatusBadge status={agent.status} /></Link></li>)}</ul></>}</section>
      <section aria-label="Active work"><h2>Active work</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Dashboard data unavailable." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Loading dashboard…" /> : projection.activeWork.length === 0 ? <EmptyState message="No active work." /> : <><p>{projection.activeWork.length} work item{projection.activeWork.length === 1 ? '' : 's'}</p><ul>{projection.activeWork.map((work) => <li key={work.id}><Link to={`/tasks/${encodeURIComponent(work.id)}`}>{work.title || work.id} · <StatusBadge status={work.status} /></Link></li>)}</ul></>}</section>
      <section aria-label="Need approval"><h2>Need approval</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Dashboard data unavailable." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Loading dashboard…" /> : <p>{projection.approvals} pending approval{projection.approvals === 1 ? '' : 's'}</p>}</section>
      <section aria-label="AI spend"><h2>AI spend</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Dashboard data unavailable." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Loading dashboard…" /> : <p>{projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Active projects"><h2>Active projects</h2>{projectionQuery.status === 'error' ? <ErrorAlert message="Dashboard data unavailable." /> : projectionQuery.status !== 'success' || !projection ? <PageState status="loading" message="Loading dashboard…" /> : projection.projects.length === 0 ? <EmptyState message="No active projects." /> : <ul>{projection.projects.map((project) => <li key={project.id}><Link to={`/projects/${encodeURIComponent(project.id)}`}>{project.displayName || project.name} · <StatusBadge status={project.status} /></Link></li>)}</ul>}</section>
      <section aria-label="Queue"><h2>Queue</h2>{queueQuery.status === 'error' ? <ErrorAlert message={`Unable to load queue: ${message(queueQuery.error)}`} onRetry={retryQueue} /> : queueQuery.status !== 'success' || !queue ? <PageState status="loading" message="Loading queue…" /> : queue.waiting.length === 0 && queue.blocked.length === 0 ? <EmptyState message="Queue is empty." /> : <><p>{`${queue.waiting.length} waiting, ${queue.blocked.length} blocked`}</p><ul>{queue.waiting.map((item) => <li key={`waiting-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {item.reason.message}</li>)}{queue.blocked.map((item) => <li key={`blocked-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {item.reason.message}</li>)}</ul></>}</section>
      <section aria-label="Approval Inbox summary"><h2>Approval Inbox summary</h2>{projectionQuery.status === 'success' && projection && <p>{projection.approvals} approval{projection.approvals === 1 ? '' : 's'} require attention.</p>}</section>
      <section aria-label="Agent Pool"><h2>Agent Pool</h2>{projectionQuery.status === 'success' && projection && <p>{projection.activeAgents.length} active of the available agent pool.</p>}</section>
      {projectionQuery.status === 'error' && <button type="button" onClick={retryProjection}>Retry</button>}
    </div>
  );
}
