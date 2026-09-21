import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

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
  const [run, setRun] = useState<AgentRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRun(await apiClient.get<AgentRun>(`/runs/${encodeURIComponent(id)}`));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async () => {
    setMutationError(null);
    try {
      await apiClient.post(`/runs/${encodeURIComponent(id)}/cancel`, {});
      await load();
    } catch (error) {
      setMutationError(errorMessage(error));
    }
  };

  if (loading) return <div className="page-state">Loading Agent Run…</div>;
  if (loadError || !run) return <div className="page-state" role="alert"><p>Unable to load Agent Run: {loadError ?? 'not found'}</p><button type="button" onClick={() => void load()}>Retry</button></div>;

  const isActive = ['STARTED', 'IN_PROGRESS', 'COMPLETING'].includes(run.status);

  return (
    <div className="agent-run-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Agent activity</p><h1>Agent Run: {run.id}</h1></div>
        <span className="status-chip">{run.status}</span>
      </header>

      {mutationError && <p className="inline-alert" role="alert">Unable to cancel run: {mutationError}</p>}

      <section className="detail-grid" aria-label="Run details">
        <div><span>Role</span><strong>{run.role}</strong></div>
        <div><span>Runtime</span><strong>{run.runtime}</strong></div>
        <div><span>Model</span><strong>{run.model}</strong></div>
        <div><span>Trigger</span><strong>{run.triggerReason ?? 'Not recorded'}</strong></div>
        <div><span>Task</span><strong>{run.taskId ?? 'System run'}</strong></div>
        <div><span>Epic</span><strong>{run.epicId ?? '—'}</strong></div>
      </section>

      <section aria-label="Run timing"><h2>Timing</h2><p>Started: {run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Not recorded'}</p><p>Ended: {run.endedAt ? new Date(run.endedAt).toLocaleString() : 'In progress'}</p></section>

      <section aria-label="Run usage" className="metric-grid">
        <div><span className="metric-value">{run.usage.inputTokens}</span><span className="metric-label">Input tokens</span></div>
        <div><span className="metric-value">{run.usage.cachedTokens}</span><span className="metric-label">Cached tokens</span></div>
        <div><span className="metric-value">{run.usage.outputTokens}</span><span className="metric-label">Output tokens</span></div>
        <div><span className="metric-value">${run.usage.cost.toFixed(4)}</span><span className="metric-label">Cost</span></div>
      </section>

      {isActive && <footer className="page-actions"><button type="button" className="danger-button" onClick={() => void cancel()}>Cancel Run</button></footer>}
    </div>
  );
}
