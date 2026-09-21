import { useCallback, useMemo } from 'react';
import { apiPaths, type EpicOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

interface EpicPageProps { id: string; }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** Представляет пользовательский экран EpicPage; авторитетные проверки выполняются backend. */
export default function EpicPage({ id }: EpicPageProps) {
  const store = useMemo(() => createQueryStore(), []);
  const epicPath = toClientPath(apiPaths.epic(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<EpicOverviewProjection>(epicPath, { signal }), [epicPath]);
  const query = useQuery(store, epicPath, undefined, fetcher);
  const projection = query.data;
  const epic = projection?.epic as { title?: string; display_id?: string; status?: string } | null | undefined;
  const notFound = query.status === 'success' && projection?.epic === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);

  return (
    <div className="epic-page">
      <h1>Epic: {epic?.title ?? epic?.display_id ?? id}</h1>
      {query.status === 'error' && <p className="inline-alert" role="alert">Unable to load epic: {errorMessage(query.error)} <button type="button" onClick={retry}>Retry</button></p>}
      {notFound && <p className="inline-alert" role="alert">Epic not found. <button type="button" onClick={retry}>Retry</button></p>}
      <section aria-label="Epic details"><h2>Details</h2><p>{query.status === 'loading' || query.status === 'idle' ? 'Loading epic projection…' : notFound ? 'Epic not found.' : epic ? `${epic.status ?? 'Unknown'} · ${projection?.tasks?.length ?? 0} tasks` : 'No epic projection is available.'}</p>{projection && !notFound && <p>Usage: {projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Epic lifecycle and parallel work graph"><h2>Lifecycle / parallel work graph</h2><p>{notFound ? 'Epic lifecycle unavailable.' : projection ? `${projection.lifecycle.stage ?? epic?.status ?? 'No lifecycle stage recorded'} · ${projection.tasks?.length ?? 0} tasks` : 'Loading epic lifecycle…'}</p><ol aria-label="Epic lifecycle stages">{projection && !notFound ? projection.lifecycle.stages?.map((stage) => <li key={stage.id} data-status={stage.status}>{stage.label}: {stage.status}</li>) : null}</ol></section>
      <section aria-label="Epic Contract"><h2>Epic Contract</h2><p>{notFound ? 'Epic contract unavailable.' : projection?.contract ? JSON.stringify(projection.contract) : query.status === 'success' ? 'No contract recorded.' : 'Loading epic contract…'}</p></section>
      <section aria-label="Epic branch and approvals"><h2>Branch / approvals / blockers</h2><p>{notFound ? 'Epic branch and approvals unavailable.' : projection ? `${projection.git.branch ?? 'No branch recorded'} · ${projection.git.repositoryPath ?? 'No repository recorded'} · ${projection.approvals.length} approvals · ${projection.blockers.length} blockers` : 'Loading epic branch and approvals…'}</p></section>
      <section aria-label="Epic events and stages"><h2>Events / review / QA / merge</h2><p>{notFound ? 'Epic events unavailable.' : projection ? `${projection.events.length} events` : 'Loading epic events…'}</p></section>
      <section aria-label="Epic tasks"><h2>Tasks</h2><ul>{notFound ? <li>Tasks unavailable.</li> : projection ? projection.tasks.length === 0 ? <li>No tasks.</li> : projection.tasks.map((task) => { const label = task.title || task.display_id || task.id; return <li key={task.id}>{<Link to={`/tasks/${encodeURIComponent(task.id)}`}>{label}</Link>} · {task.status}</li>; }) : <li>Loading tasks…</li>}</ul></section>
    </div>
  );
}
