import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert, PageState } from '../../components/PageState.js';
import StatusBadge from '../../components/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';
import {
  getRunEvents,
  getRunTools,
  getRunPermissions,
  getRunRecovery,
} from './api.js';

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

  // State for new sections
  interface EventItem { id: string; type: string; createdAt: string; payload?: unknown; }
  interface ToolResponse { tools: string[]; }
  interface AuditEntry { id: string; action: string; actor: string; aggregateType: string; aggregateId: string; details?: unknown; createdAt: string; }
  interface RecoveryAttempt { id: string; roleLevel: string; failureType: string; attemptCount: number; timestamp: string; fingerprint?: unknown; }
  interface RecoveryState { id: string; status: string; reason: string; createdAt: string; updatedAt: string; }
  interface RecoveryResponse {
    runId: string;
    taskId: string | null;
    runStatus: string;
    recovery: {
      attempts: RecoveryAttempt[];
      schedulerRequests: unknown[];
      state: RecoveryState | null;
    } | null;
  }

  const [eventsQuery, setEventsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: EventItem[] | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [toolsQuery, setToolsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: ToolResponse | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [permissionsQuery, setPermissionsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: AuditEntry[] | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [recoveryQuery, setRecoveryQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: RecoveryResponse | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });

  const cancel = async () => {
    await mutationStore.execute('cancel-run', () => apiClient.post(cancelPath, {}), query.refetch).catch(() => undefined);
  };

  // Fetch related data when run is loaded
  useEffect(() => {
    if (!run) return;

    // Load events
    setEventsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunEvents(id)
      .then((data) => setEventsQuery({ status: 'success', data, error: null }))
      .catch((err) => setEventsQuery({ status: 'error', data: null, error: err }));

    // Load tools
    setToolsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunTools(id)
      .then((data) => setToolsQuery({ status: 'success', data, error: null }))
      .catch((err) => setToolsQuery({ status: 'error', data: null, error: err }));

    // Load permissions
    setPermissionsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunPermissions(id)
      .then((data) => setPermissionsQuery({ status: 'success', data, error: null }))
      .catch((err) => setPermissionsQuery({ status: 'error', data: null, error: err }));

    // Load recovery
    setRecoveryQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunRecovery(id)
      .then((data) => setRecoveryQuery({ status: 'success', data, error: null }))
      .catch((err) => setRecoveryQuery({ status: 'error', data: null, error: err }));
  }, [run, id]);

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

      {/* Events section */}
      <section aria-label="Events">
        <h2>Events</h2>
        {eventsQuery.status === 'loading' && <p>Loading events…</p>}
        {eventsQuery.status === 'error' && <p className="error">Unable to load events: {errorMessage(eventsQuery.error)}</p>}
        {eventsQuery.status === 'success' && eventsQuery.data && eventsQuery.data.length === 0 && <p>No events recorded.</p>}
        {eventsQuery.status === 'success' && eventsQuery.data && eventsQuery.data.length > 0 && (
          <ul>
            {eventsQuery.data.map((event) => (
              <li key={event.id}>
                <strong>{event.type}</strong> at {new Date(event.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tools section */}
      <section aria-label="Tools">
        <h2>Allowed Tools</h2>
        {toolsQuery.status === 'loading' && <p>Loading tools…</p>}
        {toolsQuery.status === 'error' && <p className="error">Unable to load tools: {errorMessage(toolsQuery.error)}</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length === 0 && <p>No tools allowed.</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length > 0 && (
          <ul>
            {toolsQuery.data.tools.map((tool: string, idx: number) => (
              <li key={idx}>{tool}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Permissions/Audit section */}
      <section aria-label="Permissions">
        <h2>Permissions & Audit Log</h2>
        {permissionsQuery.status === 'loading' && <p>Loading permissions…</p>}
        {permissionsQuery.status === 'error' && <p className="error">Unable to load permissions: {errorMessage(permissionsQuery.error)}</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length === 0 && <p>No audit entries.</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length > 0 && (
          <ul>
            {permissionsQuery.data.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.action}</strong> by {entry.actor} at {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recovery section */}
      <section aria-label="Recovery">
        <h2>Recovery</h2>
        {recoveryQuery.status === 'loading' && <p>Loading recovery data…</p>}
        {recoveryQuery.status === 'error' && <p className="error">Unable to load recovery: {errorMessage(recoveryQuery.error)}</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery === null && <p>No recovery data available.</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery && (
          <div>
            <p>Task: {recoveryQuery.data.taskId ?? '—'}</p>
            <p>Run Status: {recoveryQuery.data.runStatus}</p>
            <h3>Recovery Attempts</h3>
            {recoveryQuery.data.recovery.attempts.length === 0 && <p>No recovery attempts.</p>}
            {recoveryQuery.data.recovery.attempts.length > 0 && (
              <ul>
                {recoveryQuery.data.recovery.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    {attempt.roleLevel} — {attempt.failureType} (attempt {attempt.attemptCount}) at {new Date(attempt.timestamp).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            <h3>State</h3>
            {recoveryQuery.data.recovery.state === null && <p>No recovery state.</p>}
            {recoveryQuery.data.recovery.state !== null && (
              <p>
                <strong>Status:</strong> {recoveryQuery.data.recovery.state.status} — {recoveryQuery.data.recovery.state.reason}
              </p>
            )}
          </div>
        )}
      </section>

      {isActive && <footer className="page-actions"><button type="button" className="danger-button" disabled={cancelState.status === 'pending'} onClick={() => void cancel()}>Cancel Run</button></footer>}
    </div>
  );
}
