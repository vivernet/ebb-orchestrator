import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths, type CancelAllRunsResult, type RunControlState } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import {
  ApiError,
  apiClient,
  cancelAllRuns,
  getRunDetail,
  pauseRun,
  resumeRun,
  setDispatchState,
  toClientPath,
} from '../../api/client.js';
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

interface ResourceLock {
  id: string;
  resource: string;
  runId: string;
  kind: string;
  heldAt: string;
}

interface SchedulerEvent {
  id: string;
  type: string;
  createdAt: string;
}

interface ExecutionProjection {
  running: Array<{ runId: string; role: string; taskId: string | null; status: string }>;
  waiting: Array<{ taskId: string; reason: WaitReason }>;
  blocked: Array<{ taskId: string; reason: WaitReason }>;
  capacity?: { configured: number; used: number };
  locks?: ResourceLock[];
  recentEvents?: SchedulerEvent[];
  dispatchState?: { paused: boolean; updatedAt: string | null };
}

interface SelectedRunProjection {
  id: string;
  status: string;
  control: RunControlState | null;
}

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

function isActiveStatus(status: string): boolean {
  return ['STARTED', 'IN_PROGRESS', 'COMPLETING'].includes(status);
}

function isTerminalStatus(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
}

interface RunControlView {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  busy: string | null;
}

function controlView(run: SelectedRunProjection): RunControlView {
  // Терминальный статус run скрывает управление (checkpoint/pause/resume/cancel)
  // даже если run_control_state ещё ACTIVE (например после отмены).
  if (isTerminalStatus(run.status)) {
    return { pause: false, resume: false, cancel: false, busy: null };
  }
  const ctrl = run.control;
  if (ctrl) {
    switch (ctrl.state) {
      case 'ACTIVE': return { pause: true, resume: false, cancel: isActiveStatus(run.status), busy: null };
      case 'PAUSE_REQUESTED': return { pause: false, resume: false, cancel: true, busy: 'Пауза запрошена…' };
      case 'PAUSED': return { pause: false, resume: true, cancel: true, busy: null };
      case 'RESUME_PENDING': return { pause: false, resume: false, cancel: true, busy: 'Возобновление…' };
      case 'CLOSED': return { pause: false, resume: false, cancel: false, busy: null };
    }
  }
  const active = isActiveStatus(run.status);
  return { pause: active, resume: false, cancel: active, busy: null };
}

const cancelOutcomeLabels: Record<string, string> = {
  CANCELLED: 'Отменено',
  NOT_ACTIVE: 'Не активно',
  FAILED: 'Ошибка остановки',
};

/**
 * Отображает только авторитетные группы очереди; управление подтверждается backend и refetch-ом.
 */
export default function ExecutionPage() {
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [cancelState, setCancelState] = useState<MutationState<unknown>>(() => mutationStore.get('cancel-run'));
  const [dispatchState, setDispatchMutation] = useState<MutationState<unknown>>(() => mutationStore.get('dispatch-state'));
  const [cancelAllState, setCancelAllMutation] = useState<MutationState<unknown>>(() => mutationStore.get('cancel-all'));
  const [pauseState, setPauseState] = useState<MutationState<unknown>>(() => mutationStore.get('run-pause'));
  const [resumeState, setResumeState] = useState<MutationState<unknown>>(() => mutationStore.get('run-resume'));
  useEffect(() => mutationStore.subscribe('cancel-run', setCancelState), [mutationStore]);
  useEffect(() => mutationStore.subscribe('dispatch-state', setDispatchMutation), [mutationStore]);
  useEffect(() => mutationStore.subscribe('cancel-all', setCancelAllMutation), [mutationStore]);
  useEffect(() => mutationStore.subscribe('run-pause', setPauseState), [mutationStore]);
  useEffect(() => mutationStore.subscribe('run-resume', setResumeState), [mutationStore]);

  const executionPath = toClientPath(apiPaths.execution);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<ExecutionProjection>(executionPath, { signal }), [executionPath]);
  const query = useQuery(null, executionPath, undefined, fetcher);
  const projection = query.data;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelAllOutcomes, setCancelAllOutcomes] = useState<CancelAllRunsResult | null>(null);
  const [selectedRun, setSelectedRun] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    data: SelectedRunProjection | null;
    error: unknown | null;
  }>({ status: 'idle', data: null, error: null });

  const openRun = useCallback((runId: string) => {
    setSelectedRun({ status: 'loading', data: null, error: null });
    getRunDetail(runId)
      .then((detail) => setSelectedRun({ status: 'success', data: { id: detail.id, status: detail.status, control: detail.control }, error: null }))
      .catch((error: unknown) => setSelectedRun({ status: 'error', data: null, error }));
  }, []);

  const runCancel = async (runId: string) => {
    await mutationStore.execute('cancel-run', () => apiClient.post(toClientPath(apiPaths.runCancel(runId)), {}), query.refetch).catch(() => undefined);
  };

  const toggleDispatch = async () => {
    const next = !(projection?.dispatchState?.paused ?? false);
    await mutationStore.execute('dispatch-state', () => setDispatchState(next), query.refetch).catch(() => undefined);
  };

  const confirmCancelAll = async () => {
    const ids = projection?.running.map((run) => run.runId) ?? [];
    setCancelAllOpen(false);
    setCancelAllOutcomes(null);
    await mutationStore.execute('cancel-all', () => cancelAllRuns(ids), query.refetch)
      .then((result) => setCancelAllOutcomes(result))
      .catch(() => undefined);
  };

  const runPause = async (runId: string) => {
    await mutationStore.execute('run-pause', () => pauseRun(runId), async () => retry()).catch(() => undefined);
  };
  const runResume = async (runId: string) => {
    await mutationStore.execute('run-resume', () => resumeRun(runId), async () => retry()).catch(() => undefined);
  };

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка очереди выполнения…" />;
  if (query.status === 'error' || !projection) {
    return <PageState status="error" message={`Не удалось загрузить очередь выполнения: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  const data = projection;
  const running = data.running;
  const dispatchPaused = data.dispatchState?.paused ?? false;
  const control = selectedRun.data ? controlView(selectedRun.data) : null;

  return (
    <div className="execution-page page-stack reference-screen reference-screen--execution">
      <div className="topbar">
        <div>
          <h1>Монитор выполнения</h1>
          <div className="sub">Состояние очереди и причины ожидания из проекции Scheduler.</div>
        </div>
        <div className="top-actions">
          {data.dispatchState && (
            <button type="button" className="btn-ghost" disabled={dispatchState.status === 'pending'} onClick={() => void toggleDispatch()}>
              {dispatchPaused ? 'Возобновить новую работу' : 'Приостановить новую работу'}
            </button>
          )}
          {running.length > 0 && <button type="button" className="btn-bad" onClick={() => setCancelAllOpen(true)}>Остановить всех агентов</button>}
          <button type="button" className="btn-ghost" onClick={retry}>Обновить</button>
        </div>
      </div>

      {dispatchState.status === 'error' && <ErrorAlert message={`Не удалось приостановить очередь: ${errorMessage(dispatchState.error)}`} onRetry={retry} />}
      {cancelState.status === 'error' && <ErrorAlert message={`Не удалось отменить запуск: ${errorMessage(cancelState.error)}`} onRetry={retry} />}
      {cancelAllState.status === 'error' && <ErrorAlert message={`Не удалось остановить агентов: ${errorMessage(cancelAllState.error)}`} onRetry={retry} />}
      {pauseState.status === 'error' && <ErrorAlert message={`Не удалось приостановить запуск: ${errorMessage(pauseState.error)}`} onRetry={retry} />}
      {resumeState.status === 'error' && <ErrorAlert message={`Не удалось возобновить запуск: ${errorMessage(resumeState.error)}`} onRetry={retry} />}

      <section className="reference-metrics" aria-label="Сводка выполнения">
        <div className="reference-metric"><span>Выполняется</span><strong>{running.length}</strong></div>
        <div className="reference-metric"><span>Ожидает</span><strong>{data.waiting.length}</strong></div>
        <div className="reference-metric"><span>Заблокировано</span><strong>{data.blocked.length}</strong></div>
        {data.capacity && (
          <div className="reference-metric"><span>Ёмкость</span><strong>{`${data.capacity.used} / ${data.capacity.configured}`}</strong></div>
        )}
        {data.dispatchState && (
          <div className="reference-metric"><span>Диспетчеризация</span><strong>{dispatchPaused ? 'пауза' : 'активна'}</strong></div>
        )}
      </section>

      {cancelAllOpen && (
        <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="Подтверждение остановки всех агентов">
          <div className="reference-panel">
            <h2>Остановить всех агентов</h2>
            <p>Будут остановлены только подтверждённые активные запуски ({running.length}):</p>
            <ul>
              {running.map((run) => <li key={run.runId}>{run.role} · {run.runId}</li>)}
            </ul>
            <div className="approval-actions">
              <button type="button" className="btn-ghost" onClick={() => setCancelAllOpen(false)}>Закрыть</button>
              <button type="button" className="btn-bad" disabled={cancelAllState.status === 'pending'} onClick={() => void confirmCancelAll()}>Подтвердить остановку</button>
            </div>
          </div>
        </div>
      )}

      {cancelAllOutcomes && (
        <section className="reference-panel" aria-label="Результаты остановки">
          <div className="section-heading"><h2>Результаты остановки</h2><span>{cancelAllOutcomes.results.length}</span></div>
          <ul className="reference-record-list">
            {cancelAllOutcomes.results.map((result) => (
              <li key={result.runId}>
                <span>{result.runId}</span>
                <StatusBadge status={result.outcome} label={cancelOutcomeLabels[result.outcome] ?? result.outcome} variant={result.outcome === 'FAILED' ? 'error' : 'default'} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="reference-columns execution-columns">
        <section className="reference-panel" aria-label="Активные запуски">
          <div className="section-heading"><h2>Выполняются</h2><span>{running.length}</span></div>
          {running.length === 0 ? <EmptyState message="Активных запусков нет." /> : (
            <ul className="reference-record-list execution-run-list">
              {running.map((run) => (
                <li key={run.runId}>
                  <div>
                    <Link to={`/runs/${encodeURIComponent(run.runId)}`}><strong>{run.role}</strong></Link>
                    <span>{run.taskId ? <Link to={`/tasks/${encodeURIComponent(run.taskId)}`}>{run.taskId}</Link> : 'Системный запуск'} · <StatusBadge status={run.status} /></span>
                    <button type="button" className="btn-ghost" onClick={() => openRun(run.runId)}>Управление {run.runId}</button>
                  </div>
                  <button type="button" className="btn-bad" disabled={cancelState.status === 'pending'} onClick={() => void runCancel(run.runId)}>Отменить</button>
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

          {data.capacity && (
            <section className="reference-panel" aria-label="Ёмкость планировщика">
              <div className="section-heading"><h2>Ёмкость планировщика</h2><span>{`${data.capacity.used} / ${data.capacity.configured}`}</span></div>
              <p>Общая занятая ёмкость: {data.capacity.used} из {data.capacity.configured}.</p>
            </section>
          )}

          {data.locks && (
            <section className="reference-panel" aria-label="Блокировки ресурсов">
              <div className="section-heading"><h2>Блокировки ресурсов</h2><span>{data.locks.length}</span></div>
              {data.locks.length === 0 ? <EmptyState message="Активных блокировок нет." /> : (
                <ul className="reference-record-list">
                  {data.locks.map((lock) => (
                    <li key={lock.id}>
                      <strong>{lock.resource}</strong>
                      <span>Удерживается {lock.runId} · {lock.kind}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {data.recentEvents && (
            <section className="reference-panel" aria-label="События планировщика">
              <div className="section-heading"><h2>События планировщика</h2><span>{data.recentEvents.length}</span></div>
              {data.recentEvents.length === 0 ? <EmptyState message="Событий планировщика нет." /> : (
                <ul className="reference-record-list">
                  {data.recentEvents.map((event) => (
                    <li key={event.id}>
                      <strong>{event.type}</strong>
                      <span>{new Date(event.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="reference-panel" aria-label="Выбранный запуск">
            <div className="section-heading"><h2>Выбранный запуск</h2></div>
            {selectedRun.status === 'loading' && <p>Загрузка управления запуском…</p>}
            {selectedRun.status === 'error' && <p className="error">Не удалось загрузить управление запуском: {errorMessage(selectedRun.error)}</p>}
            {selectedRun.status === 'success' && selectedRun.data && control && (
              <div>
                <p><strong>{selectedRun.data.id}</strong> · <StatusBadge status={selectedRun.data.status} /></p>
                {control.busy && <p className="reference-callout">{control.busy}</p>}
                <div className="approval-actions">
                  {control.pause && <button type="button" className="btn-ghost" onClick={() => void runPause(selectedRun.data!.id)}>Приостановить запуск</button>}
                  {control.resume && <button type="button" className="btn-ghost" onClick={() => void runResume(selectedRun.data!.id)}>Возобновить запуск</button>}
                  {control.cancel && <button type="button" className="btn-bad" onClick={() => void runCancel(selectedRun.data!.id)}>Отменить запуск</button>}
                </div>
              </div>
            )}
            {selectedRun.status === 'idle' && <p className="reference-callout">Выберите запуск, чтобы увидеть управление.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
