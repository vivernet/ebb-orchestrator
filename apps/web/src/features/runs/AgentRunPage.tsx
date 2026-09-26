import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage, auditActionLabel, recoveryFailureLabel, recoveryReasonLabel, recoveryRoleLabel, ru, runEventLabel, runTriggerLabel, statusLabel } from '../../i18n/ru.js';
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
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
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

    // Load событий
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

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка запуска агента…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить запуск агента: ${errorMessage(query.error)}`} onRetry={retry} />;
  if (!run) return <ErrorAlert message={`Не удалось загрузить запуск агента: ${ru.runs.notFound}`} onRetry={retry} />;

  const isActive = ['STARTED', 'IN_PROGRESS', 'COMPLETING'].includes(run.status);

  return (
    <div className="agent-run-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Активность агента</p><h1>Запуск агента: {run.id}</h1></div>
        <StatusBadge status={run.status} />
      </header>

      {cancelState.status === 'error' && <ErrorAlert message={`Не удалось отменить запуск: ${errorMessage(cancelState.error)}`} />}

      <section className="detail-grid" aria-label="Сведения о запуске">
        <div><span>Роль</span><strong>{run.role}</strong></div>
        <div><span>Среда выполнения</span><strong>{run.runtime}</strong></div>
        <div><span>Модель</span><strong>{run.model}</strong></div>
        <div><span>Причина запуска</span><strong>{runTriggerLabel(run.triggerReason)}</strong></div>
        <div><span>Задача</span><strong>{run.taskId ? <Link to={`/tasks/${encodeURIComponent(run.taskId)}`}>{run.taskId}</Link> : 'Системный запуск'}</strong></div>
        <div><span>Эпик</span><strong>{run.epicId ? <Link to={`/epics/${encodeURIComponent(run.epicId)}`}>{run.epicId}</Link> : '—'}</strong></div>
      </section>

      <section aria-label="Время запуска"><h2>Время</h2><p>Начало: {run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Не указано'}</p><p>Завершение: {run.endedAt ? new Date(run.endedAt).toLocaleString() : 'Выполняется'}</p></section>

      <section aria-label="Использование запуска" className="metric-grid">
        <div><span className="metric-value">{run.usage.inputTokens}</span><span className="metric-label">{ru.runs.inputTokens}</span></div>
        <div><span className="metric-value">{run.usage.cachedTokens}</span><span className="metric-label">{ru.runs.cachedTokens}</span></div>
        <div><span className="metric-value">{run.usage.outputTokens}</span><span className="metric-label">{ru.runs.outputTokens}</span></div>
        <div><span className="metric-value">${run.usage.cost.toFixed(4)}</span><span className="metric-label">Стоимость</span></div>
      </section>

      {/* Events section */}
      <section aria-label="События">
        <h2>События</h2>
        {eventsQuery.status === 'loading' && <p>Загрузка событий…</p>}
        {eventsQuery.status === 'error' && <p className="error">Не удалось загрузить события: {errorMessage(eventsQuery.error)}</p>}
        {eventsQuery.status === 'success' && eventsQuery.data && eventsQuery.data.length === 0 && <p>Событий нет.</p>}
        {eventsQuery.status === 'success' && eventsQuery.data && eventsQuery.data.length > 0 && (
          <ul>
            {eventsQuery.data.map((event) => (
              <li key={event.id}>
                <strong>{runEventLabel(event.type)}</strong> — {new Date(event.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tools section */}
      <section aria-label="Инструменты">
        <h2>Разрешённые инструменты</h2>
        {toolsQuery.status === 'loading' && <p>Загрузка инструментов…</p>}
        {toolsQuery.status === 'error' && <p className="error">Не удалось загрузить инструменты: {errorMessage(toolsQuery.error)}</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length === 0 && <p>Нет разрешённых инструментов.</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length > 0 && (
          <ul>
            {toolsQuery.data.tools.map((tool: string, idx: number) => (
              <li key={idx}>{tool}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Permissions/Audit section */}
      <section aria-label="Разрешения">
        <h2>Разрешения и журнал аудита</h2>
        {permissionsQuery.status === 'loading' && <p>Загрузка разрешений…</p>}
        {permissionsQuery.status === 'error' && <p className="error">Не удалось загрузить разрешения: {errorMessage(permissionsQuery.error)}</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length === 0 && <p>Записей аудита нет.</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length > 0 && (
          <ul>
            {permissionsQuery.data.map((entry) => (
              <li key={entry.id}>
                <strong>{auditActionLabel(entry.action)}</strong> — {entry.actor} — {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Раздел восстановления */}
      <section aria-label="Восстановление">
        <h2>Восстановление</h2>
        {recoveryQuery.status === 'loading' && <p>Загрузка данных восстановления…</p>}
        {recoveryQuery.status === 'error' && <p className="error">Не удалось загрузить данные восстановления: {errorMessage(recoveryQuery.error)}</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery === null && <p>Данные восстановления недоступны.</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery && (
          <div>
            <p>Задача: {recoveryQuery.data.taskId ?? '—'}</p>
            <p>Статус запуска: {statusLabel(recoveryQuery.data.runStatus)}</p>
            <h3>Попытки восстановления</h3>
            {recoveryQuery.data.recovery.attempts.length === 0 && <p>Попыток восстановления нет.</p>}
            {recoveryQuery.data.recovery.attempts.length > 0 && (
              <ul>
                {recoveryQuery.data.recovery.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    {recoveryRoleLabel(attempt.roleLevel)} — {recoveryFailureLabel(attempt.failureType)} (попытка {attempt.attemptCount}) — {new Date(attempt.timestamp).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            <h3>Состояние</h3>
            {recoveryQuery.data.recovery.state === null && <p>Состояние восстановления отсутствует.</p>}
            {recoveryQuery.data.recovery.state !== null && (
              <p>
                <strong>Статус:</strong> {statusLabel(recoveryQuery.data.recovery.state.status)} — {recoveryReasonLabel()}
              </p>
            )}
          </div>
        )}
      </section>

      {isActive && <footer className="page-actions"><button type="button" className="danger-button" disabled={cancelState.status === 'pending'} onClick={() => void cancel()}>Отменить запуск</button></footer>}
    </div>
  );
}
