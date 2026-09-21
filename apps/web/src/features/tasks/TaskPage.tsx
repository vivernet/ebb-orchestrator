import { useCallback, useMemo } from 'react';
import { apiPaths, type TaskOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import WorkflowTimeline, { TASK_LIFECYCLE_STAGES } from '../../components/WorkflowTimeline.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

interface TaskPageProps { id?: string; }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Представляет пользовательский экран TaskPage; авторитетные проверки выполняются backend. */
export default function TaskPage({ id = '' }: TaskPageProps) {
  const store = useMemo(() => createQueryStore(), []);
  const taskPath = toClientPath(apiPaths.task(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<TaskOverviewProjection>(taskPath, { signal }), [taskPath]);
  const query = useQuery(store, taskPath, undefined, fetcher, { enabled: Boolean(id) });
  const projection = query.data;
  const task = projection?.task as { title?: string; display_id?: string; status?: string; project_id?: string; epic_id?: string | null } | null | undefined;
  const notFound = query.status === 'success' && projection?.task === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);
  const contract = notFound ? 'Task contract unavailable.' : projection?.contract ? JSON.stringify(projection.contract) : query.status === 'success' ? 'No contract recorded.' : 'Loading task contract…';

  return (
    <div className="task-page">
      <h1>Task: {(task?.title ?? task?.display_id ?? id) || 'Loading'}</h1>
      {query.status === 'error' && <p className="inline-alert" role="alert">Unable to load task: {errorMessage(query.error)} <button type="button" onClick={retry}>Retry</button></p>}
      {notFound && <p className="inline-alert" role="alert">Task not found. <button type="button" onClick={retry}>Retry</button></p>}
      <section aria-label="Contract"><h2>Contract</h2><p>{contract}</p></section>
      <section aria-label="Workflow"><h2>Workflow</h2><p>{notFound ? 'Task workflow unavailable.' : projection ? `Status: ${projection.lifecycle.status ?? task?.status ?? 'Unknown'}` : `Status: ${query.status === 'error' ? 'Unavailable' : 'Loading task projection…'}`}</p>{projection && !notFound && <WorkflowTimeline stages={TASK_LIFECYCLE_STAGES} currentStage={projection.lifecycle.stage ?? projection.lifecycle.status} />}</section>
      <section aria-label="Related work"><h2>Related work</h2>{notFound ? <p>Related work unavailable.</p> : <p>{task?.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>Project</Link> : null}{task?.project_id && task.epic_id ? ' · ' : ''}{task?.epic_id ? <Link to={`/epics/${encodeURIComponent(task.epic_id)}`}>Epic</Link> : null}</p>}</section>
      <section aria-label="Agent Runs"><h2>Agent Runs</h2><ul>{notFound ? <li>Agent runs unavailable.</li> : projection ? projection.runs.length === 0 ? <li>No agent runs.</li> : projection.runs.map((run) => { const label = `${run.role} · ${run.status}`; return <li key={run.id}><Link to={`/runs/${encodeURIComponent(run.id)}`}>{label}</Link></li>; }) : <li>Loading agent runs…</li>}</ul></section>
      <section aria-label="Findings"><h2>Findings</h2><p>{notFound ? 'Findings unavailable.' : projection ? projection.findings.length === 0 && projection.defects.length === 0 ? 'No findings or defects.' : `${projection.findings.length} findings · ${projection.defects.length} defects` : 'Loading findings…'}</p></section>
      <section aria-label="Dependencies and events"><h2>Dependencies / events</h2><p>{notFound ? 'Dependencies and events unavailable.' : projection ? `${projection.dependencies.length} dependencies · ${projection.events.length} events · ${projection.approvals.length} approvals` : 'Loading dependencies and events…'}</p>{projection && !notFound && projection.dependencies.length > 0 && <ul>{projection.dependencies.map((dependency) => <li key={dependency.id}><Link to={`/tasks/${encodeURIComponent(dependency.taskId)}`}>{dependency.taskId}</Link> depends on <Link to={`/tasks/${encodeURIComponent(dependency.dependsOnTaskId)}`}>{dependency.dependsOnTaskId}</Link></li>)}</ul>}</section>
      <section aria-label="Git"><h2>Git</h2><p>{notFound ? 'Git state unavailable.' : projection ? `${projection.git.branch ?? 'No branch recorded'} · ${projection.git.repositoryPath ?? 'No repository recorded'}${projection.git.github?.url ? ` · ${projection.git.github.url}` : ''}` : 'Loading Git state…'}</p></section>
      <section aria-label="Recovery"><h2>Recovery</h2><p>{notFound ? 'Recovery state unavailable.' : projection?.waitReason?.message ?? (query.status === 'success' ? 'No recovery state recorded.' : 'Loading recovery state…')}</p></section>
      <section aria-label="Usage"><h2>Usage</h2><p>{notFound ? 'Usage unavailable.' : projection ? `${projection.usage.totalTokens} tokens · $${projection.usage.cost.toFixed(2)}` : 'Loading usage…'}</p></section>
    </div>
  );
}
