import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, waitReasonLabel } from '../../i18n/ru.js';
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

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Отображает только авторитетные группы очереди; отмена применяется к одному Run и подтверждается refetch.
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

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка очереди выполнения…" />;
  if (query.status === 'error' || !projection) {
    return <PageState status="error" message={`Не удалось загрузить очередь выполнения: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  const data = projection;

  return (
    <div className="execution-page page-stack reference-screen reference-screen--execution">
      <div className="topbar">
        <div>
          <h1>Монитор выполнения</h1>
          <div className="sub">Состояние очереди и причины ожидания из проекции Scheduler.</div>
        </div>
        <div className="top-actions">
          <button type="button" className="btn-ghost" onClick={retry}>Обновить</button>
        </div>
      </div>

      {cancelState.status === 'error' && <ErrorAlert message={`Не удалось отменить запуск: ${errorMessage(cancelState.error)}`} onRetry={retry} />}

      <section className="reference-metrics" aria-label="Сводка выполнения">
        <div className="reference-metric"><span>Выполняется</span><strong>{data.running.length}</strong></div>
        <div className="reference-metric"><span>Ожидает</span><strong>{data.waiting.length}</strong></div>
        <div className="reference-metric"><span>Заблокировано</span><strong>{data.blocked.length}</strong></div>
      </section>

      <div className="reference-columns execution-columns">
        <section className="reference-panel" aria-label="Активные запуски">
          <div className="section-heading"><h2>Выполняются</h2><span>{data.running.length}</span></div>
          {data.running.length === 0 ? <EmptyState message="Активных запусков нет." /> : (
            <ul className="reference-record-list execution-run-list">
              {data.running.map((run) => (
                <li key={run.runId}>
                  <div>
                    <Link to={`/runs/${encodeURIComponent(run.runId)}`}><strong>{run.role}</strong></Link>
                    <span>{run.taskId ? <Link to={`/tasks/${encodeURIComponent(run.taskId)}`}>{run.taskId}</Link> : 'Системный запуск'} · <StatusBadge status={run.status} /></span>
                  </div>
                  <button type="button" className="btn-bad" disabled={cancelState.status === 'pending'} onClick={() => void cancelRun(run.runId)}>Отменить</button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="reference-column">
          <section className="reference-panel" aria-label="Очередь ожидания">
            <div className="section-heading"><h2>Ожидают</h2><span>{data.waiting.length}</span></div>
            {data.waiting.length === 0 ? <EmptyState message="Задач в очереди ожидания нет." /> : (
              <ul className="reference-record-list">
                {data.waiting.map((task) => (
                  <li key={task.taskId}>
                    <Link to={`/tasks/${encodeURIComponent(task.taskId)}`}><strong>{task.taskId}</strong><span>{waitReasonLabel(task.reason.code)}</span></Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="reference-panel" aria-label="Заблокированная работа">
            <div className="section-heading"><h2>Заблокировано</h2><span>{data.blocked.length}</span></div>
            {data.blocked.length === 0 ? <EmptyState message="Заблокированных задач нет." /> : (
              <ul className="reference-record-list">
                {data.blocked.map((task) => (
                  <li key={task.taskId}>
                    <Link to={`/tasks/${encodeURIComponent(task.taskId)}`}><strong>{task.taskId}</strong><span>{waitReasonLabel(task.reason.code)}</span></Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
