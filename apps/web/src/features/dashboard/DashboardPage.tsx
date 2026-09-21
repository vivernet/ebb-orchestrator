import { useCallback, useMemo } from 'react';
import { apiPaths, type DashboardProjection, type ExecutionQueueProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
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
      <section aria-label="Running agents"><h2>Running agents</h2>{projectionQuery.status === 'error' ? <p role="alert">Unable to load dashboard: {message(projectionQuery.error)}</p> : projectionQuery.status !== 'success' || !projection ? <p>Loading dashboard…</p> : (projection.activeAgents.length === 0 ? <p>No running agents.</p> : <><p>{projection.activeAgents.length} active agent{projection.activeAgents.length === 1 ? '' : 's'}</p><ul>{projection.activeAgents.map((agent) => <li key={agent.runId}><Link to={`/runs/${encodeURIComponent(agent.runId)}`}>{agent.role} · {agent.status}</Link></li>)}</ul></>)}</section>
      <section aria-label="Active work"><h2>Active work</h2>{projectionQuery.status === 'error' ? <p>Dashboard data unavailable.</p> : projectionQuery.status !== 'success' || !projection ? <p>Loading dashboard…</p> : (projection.activeWork.length === 0 ? <p>No active work.</p> : <><p>{projection.activeWork.length} work item{projection.activeWork.length === 1 ? '' : 's'}</p><ul>{projection.activeWork.map((work) => <li key={work.id}><Link to={`/tasks/${encodeURIComponent(work.id)}`}>{work.title || work.id} · {work.status}</Link></li>)}</ul></>)}</section>
      <section aria-label="Need approval"><h2>Need approval</h2>{projectionQuery.status === 'error' ? <p>Dashboard data unavailable.</p> : projectionQuery.status !== 'success' || !projection ? <p>Loading dashboard…</p> : <p>{projection.approvals} pending approval{projection.approvals === 1 ? '' : 's'}</p>}</section>
      <section aria-label="AI spend"><h2>AI spend</h2>{projectionQuery.status === 'error' ? <p>Dashboard data unavailable.</p> : projectionQuery.status !== 'success' || !projection ? <p>Loading dashboard…</p> : <p>{projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Active projects"><h2>Active projects</h2>{projectionQuery.status === 'error' ? <p>Dashboard data unavailable.</p> : projectionQuery.status !== 'success' || !projection ? <p>Loading dashboard…</p> : (projection.projects.length === 0 ? <p>No active projects.</p> : <ul>{projection.projects.map((project) => <li key={project.id}><Link to={`/projects/${encodeURIComponent(project.id)}`}>{project.displayName || project.name} · {project.status}</Link></li>)}</ul>)}</section>
      <section aria-label="Queue"><h2>Queue</h2>{queueQuery.status === 'error' ? <><p role="alert">Unable to load queue: {message(queueQuery.error)}</p><button type="button" onClick={retryQueue}>Retry</button></> : queueQuery.status !== 'success' || !queue ? <p>Loading queue…</p> : (queue.waiting.length === 0 && queue.blocked.length === 0 ? <p>Queue is empty.</p> : <><p>{`${queue.waiting.length} waiting, ${queue.blocked.length} blocked`}</p><ul>{queue.waiting.map((item) => <li key={`waiting-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {item.reason.message}</li>)}{queue.blocked.map((item) => <li key={`blocked-${item.taskId}`}><Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>: {item.reason.message}</li>)}</ul></>)}</section>
      <section aria-label="Approval Inbox summary"><h2>Approval Inbox summary</h2>{projectionQuery.status === 'success' && projection && <p>{projection.approvals} approval{projection.approvals === 1 ? '' : 's'} require attention.</p>}</section>
      <section aria-label="Agent Pool"><h2>Agent Pool</h2>{projectionQuery.status === 'success' && projection && <p>{projection.activeAgents.length} active of the available agent pool.</p>}</section>
      {projectionQuery.status === 'error' && <button type="button" onClick={retryProjection}>Retry</button>}
    </div>
  );
}
