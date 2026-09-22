import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert, PageState } from '../../components/PageState.js';
import StatusBadge from '../../components/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';

interface AgentRun {
  id: string;
  role: string;
  runtime: string;
  model: string;
  status: string;
  triggerReason: string | null;
  taskId: string | null;
  epicId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; cost: number };
}

interface AgentRunPageProps {
  id: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Показывает безопасную проекцию Agent Run. Prompt, capability, необработанный
 * результат и служебные artifacts намеренно не запрашиваются браузер-клиентом.
 */
export default function AgentRunPage({ id }: AgentRunPageProps) {
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [cancelState, setCancelState] = useState<MutationState<unknown>>(() => mutationStore.get('cancel-run'));
  useEffect(() => mutationStore.subscribe('cancel-run', setCancelState), [mutationStore]);
  const runPath = toClientPath(apiPaths.run(id));
  const cancelPath = toClientPath(apiPaths.runCancel(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<AgentRun>(runPath, { signal }), [runPath]);
  const query = useQuery(null, runPath, undefined, fetcher);
  const run = query.data;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const cancel = async () => {
    await mutationStore.execute('cancel-run', () => apiClient.post(cancelPath, {}), query.refetch).catch(() => undefined);
  };

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Loading Agent Run…" />;
  if (query.status === 'error') return <PageState status="error" message={`Unable to load Agent Run: ${errorMessage(query.error)}`} onRetry={retry} />;
  if (!run) return <ErrorAlert message="Unable to load Agent Run: not found" onRetry={retry} />;

  const isActive = ['STARTED', 'IN_PROGRESS', 'COMPLETING'].includes(run.status);

  return (
    <div className="agent-run-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Agent activity</p><h1>Agent Run: {run.id}</h1></div>
        <StatusBadge status={run.status} />
      </header>

      {cancelState.status === 'error' && <ErrorAlert message={`Unable to cancel run: ${errorMessage(cancelState.error)}`} />}

      <section className="detail-grid" aria-label="Run details">
        <div><span>Role</span><strong>{run.role}</strong></div>
        <div><span>Runtime</span><strong>{run.runtime}</strong></div>
        <div><span>Model</span><strong>{run.model}</strong></div>
        <div><span>Trigger</span><strong>{run.triggerReason ?? 'Not recorded'}</strong></div>
        <div><span>Task</span><strong>{run.taskId ? <Link to={`/tasks/${encodeURIComponent(run.taskId)}`}>{run.taskId}</Link> : 'System run'}</strong></div>
        <div><span>Epic</span><strong>{run.epicId ? <Link to={`/epics/${encodeURIComponent(run.epicId)}`}>{run.epicId}</Link> : '—'}</strong></div>
      </section>

      <section aria-label="Run timing"><h2>Timing</h2><p>Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Not recorded'}</p><p>Ended: {run.endedAt ? new Date(run.endedAt).toLocaleString() : 'In progress'}</p></section>

      <section aria-label="Run usage" className="metric-grid">
        <div><span className="metric-value">{run.usage.inputTokens}</span><span className="metric-label">Input tokens</span></div>
        <div><span className="metric-value">{run.usage.cachedTokens}</span><span className="metric-label">Cached tokens</span></div>
        <div><span className="metric-value">{run.usage.outputTokens}</span><span className="metric-label">Output tokens</span></div>
        <div><span className="metric-value">${run.usage.cost.toFixed(4)}</span><span className="metric-label">Cost</span></div>
      </section>

      {isActive && <footer className="page-actions"><button type="button" className="danger-button" disabled={cancelState.status === 'pending'} onClick={() => void cancel()}>Cancel Run</button></footer>}
    </div>
  );
}
