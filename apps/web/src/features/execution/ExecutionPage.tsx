import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

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
  const [projection, setProjection] = useState<ExecutionProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjection(await apiClient.get<ExecutionProjection>('/execution'));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cancelRun = async (runId: string) => {
    setMutationError(null);
    try {
      await apiClient.post(`/runs/${encodeURIComponent(runId)}/cancel`, {});
      await load();
    } catch (error) {
      setMutationError(errorMessage(error));
    }
  };

  if (loading) return <div className="page-state">Loading execution queue…</div>;
  if (loadError) {
    return <div className="page-state" role="alert"><p>Unable to load execution queue: {loadError}</p><button type="button" onClick={() => void load()}>Retry</button></div>;
  }

  const data = projection ?? { running: [], waiting: [], blocked: [] };
  const rows: ExecutionRow[] = [
    ...data.running.map((run) => ({ id: run.runId, kind: 'run' as const, role: run.role, target: run.taskId ?? 'System', status: run.status, reason: null })),
    ...data.waiting.map((task) => ({ id: task.taskId, kind: 'waiting' as const, role: 'Scheduler', target: task.taskId, status: 'WAITING', reason: task.reason })),
    ...data.blocked.map((task) => ({ id: task.taskId, kind: 'blocked' as const, role: 'Scheduler', target: task.taskId, status: 'BLOCKED', reason: task.reason })),
  ];

  return (
    <div className="execution-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Operations</p><h1>Execution monitor</h1></div>
        <button type="button" onClick={() => void load()}>Refresh</button>
      </header>

      {mutationError && <p className="inline-alert" role="alert">Unable to cancel run: {mutationError}</p>}

      <section aria-label="Execution summary" className="metric-grid">
        <div><span className="metric-value">{data.running.length}</span><span className="metric-label">Running</span></div>
        <div><span className="metric-value">{data.waiting.length}</span><span className="metric-label">Waiting</span></div>
        <div><span className="metric-value">{data.blocked.length}</span><span className="metric-label">Blocked</span></div>
      </section>

      <section aria-label="Execution queue" className="table-card">
        <div className="section-heading"><h2>Queue</h2><p>Reasons come from the scheduler projection.</p></div>
        {rows.length === 0 ? <p className="empty-state">No active, waiting, or blocked work.</p> : (
          <div className="table-scroll"><table className="execution-queue-table"><thead><tr><th>Role</th><th>Target</th><th>Status</th><th>Wait reason</th><th aria-label="Actions" /></tr></thead><tbody>
            {rows.map((entry) => <tr key={`${entry.kind}-${entry.id}`}><td>{entry.role}</td><td>{entry.target}</td><td><span className="status-chip">{entry.status}</span></td><td>{entry.reason ? <><strong>{entry.reason.code}</strong><span className="reason-message">{entry.reason.message}</span></> : '—'}</td><td>{entry.kind === 'run' && <button type="button" className="danger-button" onClick={() => void cancelRun(entry.id)}>Cancel</button>}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}
