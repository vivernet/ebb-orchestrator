import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/PageState.js';
import StatusBadge from '../../components/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';

interface WaitReason {
  code: string;
  message: string;
}

interface ExecutionProjection {
  running: Array<{ runId: string; role: string; taskId: string | null; status: string }>;
  waiting: Array<{ taskId: string; reason: WaitReason }>;
  blocked: Array<{ taskId: string; reason: WaitReason }>;
}

interface ExecutionRow {
  id: string;
  kind: 'run' | 'waiting' | 'blocked';
  role: string;
  target: string;
  status: string;
  reason: WaitReason | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Отображает авторитетную проекцию scheduler: активные runs, ожидающие и
 * заблокированные задачи. UI не выводит действия, для которых backend не
 * предоставляет endpoint или policy-проверку.
 */
export default function ExecutionPage() {
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [cancelState, setCancelState] = useState<MutationState<unknown>>(() => mutationStore.get('cancel-run'));
  useEffect(() => mutationStore.subscribe('cancel-run', setCancelState), [mutationStore]);
  const executionPath = toClientPath(apiPaths.execution);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<ExecutionProjection>(executionPath, { signal }), [executionPath]);
  const query = useQuery(null, executionPath, undefined, fetcher);
  const projection = query.data;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const cancelRun = async (runId: string) => {
    await mutationStore.execute('cancel-run', () => apiClient.post(toClientPath(apiPaths.runCancel(runId)), {}), query.refetch).catch(() => undefined);
  };

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Loading execution queue…" />;
  if (query.status === 'error' || !projection) {
    return <PageState status="error" message={`Unable to load execution queue: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  const data = projection;
  const rows: ExecutionRow[] = [
    ...data.running.map((run) => ({ id: run.runId, kind: 'run' as const, role: run.role, target: run.taskId ?? 'System', status: run.status, reason: null })),
    ...data.waiting.map((task) => ({ id: task.taskId, kind: 'waiting' as const, role: 'Scheduler', target: task.taskId, status: 'WAITING', reason: task.reason })),
    ...data.blocked.map((task) => ({ id: task.taskId, kind: 'blocked' as const, role: 'Scheduler', target: task.taskId, status: 'BLOCKED', reason: task.reason })),
  ];

  return (
    <div className="execution-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Operations</p><h1>Execution monitor</h1></div>
        <button type="button" onClick={retry}>Refresh</button>
      </header>

      {cancelState.status === 'error' && <ErrorAlert message={`Unable to cancel run: ${errorMessage(cancelState.error)}`} />}

      <section aria-label="Execution summary" className="metric-grid">
        <div><span className="metric-value">{data.running.length}</span><span className="metric-label">Running</span></div>
        <div><span className="metric-value">{data.waiting.length}</span><span className="metric-label">Waiting</span></div>
        <div><span className="metric-value">{data.blocked.length}</span><span className="metric-label">Blocked</span></div>
      </section>

      <section aria-label="Execution queue" className="table-card">
        <div className="section-heading"><h2>Queue</h2><p>Reasons come from the scheduler projection.</p></div>
        {rows.length === 0 ? <EmptyState message="No active, waiting, or blocked work." /> : (
          <div className="table-scroll"><table className="execution-queue-table"><thead><tr><th>Role</th><th>Target</th><th>Status</th><th>Wait reason</th><th aria-label="Actions" /></tr></thead><tbody>
            {rows.map((entry) => <tr key={`${entry.kind}-${entry.id}`}><td>{entry.kind === 'run' ? <Link to={`/runs/${encodeURIComponent(entry.id)}`}>{entry.role}</Link> : entry.role}</td><td>{entry.kind === 'run' && data.running.find((run) => run.runId === entry.id)?.taskId ? <Link to={`/tasks/${encodeURIComponent(data.running.find((run) => run.runId === entry.id)?.taskId ?? '')}`}>{entry.target}</Link> : entry.kind !== 'run' ? <Link to={`/tasks/${encodeURIComponent(entry.id)}`}>{entry.target}</Link> : entry.target}</td><td><StatusBadge status={entry.status} /></td><td>{entry.reason ? <><strong>{entry.reason.code}</strong><span className="reason-message">{entry.reason.message}</span></> : '—'}</td><td>{entry.kind === 'run' && <button type="button" className="danger-button" disabled={cancelState.status === 'pending'} onClick={() => void cancelRun(entry.id)}>Cancel</button>}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
