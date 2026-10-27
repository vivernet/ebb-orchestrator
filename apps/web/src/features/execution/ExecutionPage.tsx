import { useCallback, useState } from 'react';
import { ApiError, apiClient, setDispatchState, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import type { ExecutionQueueProjection } from '@ebb-orchestrator/contracts';
import './execution.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const queueStore = createQueryStore();

/** Локализованная подпись причины ожидания/блокировки. */
function reasonLabel(code: string): string {
  const known: Record<string, string> = {
    WAITING_FOR_CAPACITY: 'Ожидает слота роли.',
    WAITING_FOR_ROLE_CAPACITY: 'Ожидает слота роли.',
    WAITING_FOR_DEPENDENCY: 'Ожидание зависимостей.',
    BLOCKED_BY_WORKFLOW: 'Заблокировано рабочим процессом.',
    RESOURCE_LOCKED: 'Блокировка ресурса.',
    WAITING_FOR_APPROVAL: 'Ожидает согласования.',
  };
  return known[code] ?? code;
}

/**
 * Очередь выполнения (reference 05): активные запуски, ожидание, ёмкость,
 * выбранный запуск, блокировки и события планировщика. Данные — только из
 * проекции /execution; отсутствующие источники рендерятся как «недоступно».
 * Пауза диспетчеризации и массовая остановка — реальные мутации API.
 */
export default function ExecutionPage() {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<ExecutionQueueProjection>(toClientPath('/api/v1/execution'), { signal }), []);
  const query = useQuery(queueStore, '/api/v1/execution', undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const projection = query.data;

  const [paused, setPaused] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<unknown | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelAllBusy, setCancelAllBusy] = useState(false);
  const [cancelAllError, setCancelAllError] = useState<unknown | null>(null);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка очереди выполнения…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить очередь выполнения: ${errorMessage(query.error)}`} onRetry={retry} />;

  const running = projection?.running ?? [];
  const waiting = projection?.waiting ?? [];
  const blocked = projection?.blocked ?? [];
  const capacity = projection?.capacity;
  const locks = projection?.locks ?? [];
  const events = projection?.recentEvents ?? [];
  const dispatchState = projection?.dispatchState;

  const effectivePaused = dispatchState?.paused ?? paused;

  const pauseQueue = async () => {
    setDispatchBusy(true);
    setDispatchError(null);
    try {
      await setDispatchState(!effectivePaused);
      setPaused(!effectivePaused);
    } catch (error) {
      setDispatchError(error);
    } finally {
      setDispatchBusy(false);
    }
  };

  const cancelAll = async () => {
    setCancelAllBusy(true);
    setCancelAllError(null);
    try {
      const ids = running.map((run) => run.runId);
      if (ids.length === 0) {
        setCancelAllOpen(false);
        return;
      }
      await apiClient.post(toClientPath('/api/v1/runs/cancel-all'), { expectedRunIds: ids });
      setCancelAllOpen(false);
      void query.refetch().catch(() => undefined);
    } catch (error) {
      setCancelAllError(error);
    } finally {
      setCancelAllBusy(false);
    }
  };

  const totalWaiting = waiting.length;
  const totalBlocked = blocked.length;
  const usedCapacity = capacity?.used ?? running.length;
  const configuredCapacity = capacity?.configured;

  return (
    <div className="reference-screen execution-page reference-screen--execution">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Очередь выполнения</h1>
          <p>Живое состояние Scheduler, активных Hermes Run и причин, по которым работа ждёт.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn" disabled={dispatchBusy} onClick={() => void pauseQueue()}>
            {effectivePaused ? 'Возобновить новую работу' : 'Приостановить new work'}
          </button>
          <button type="button" className="pf-btn danger" onClick={() => setCancelAllOpen(true)}>Остановить всех агентов</button>
        </div>
      </div>

      {dispatchError ? <p className="ex-note bad">Не удалось приостановить очередь: {errorMessage(dispatchError)}</p> : null}
      {cancelAllError ? <p className="ex-note bad">Не удалось остановить агентов: {errorMessage(cancelAllError)}</p> : null}
      {cancelAllOpen && (
        <div className="ex-confirm">
          <div className="ex-confirm-box">
            <p>Остановить всех агентов? Текущие запуски будут остановлены по их состоянию.</p>
            <div className="pf-actions">
              <button type="button" className="pf-btn" onClick={() => setCancelAllOpen(false)}>Отмена</button>
              <button type="button" className="pf-btn danger" disabled={cancelAllBusy} onClick={() => void cancelAll()}>Подтвердить остановку</button>
            </div>
          </div>
        </div>
      )}

      <section className="pf-metrics pf-metrics--5" aria-label="Сводка очереди">
        <div className="pf-metric"><span>Выполняется</span><b>{usedCapacity}{configuredCapacity !== undefined ? ` / ${configuredCapacity}` : ''}</b></div>
        <div className="pf-metric"><span>В очереди</span><b>{totalWaiting}</b></div>
        <div className="pf-metric"><span>Blocked</span><b className="ex-warn">{totalBlocked}</b></div>
        <div className="pf-metric"><span>Пауза диспетчеризации</span><b>{effectivePaused ? 'Да' : 'Нет'}</b></div>
      </section>

      <div className="pf-grid ex-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Выполняется now</h3><span className="pf-chip">{running.length} активных запусков</span></div>
            {running.length === 0 ? (
              <div className="ex-qitem-reason">Активных запусков нет.</div>
            ) : running.map((run) => (
              <div key={run.runId} className="ex-run">
                <div>
                  <b><span className="pf-dot busy" />{run.role} · {run.runId}</b>
                  <div className="ex-run-sub">{run.taskId ? `TASK: ${run.taskId}` : 'недоступно'}</div>
                  <div className="ex-run-meta">
                    <span className="pf-chip">{run.status}</span>
                  </div>
                </div>
                <div className="ex-run-time">
                  <span className="pf-unavail">прошло</span>
                  <b className="pf-unavail">недоступно</b>
                </div>
                <button type="button" className="pf-btn" onClick={() => { window.location.hash = `#/runs/${run.runId}`; }}>Открыть</button>
              </div>
            ))}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Очередь ожидания</h3><span className="pf-chip">отсортировано по эффективному приоритету</span></div>
            {waiting.length === 0 && blocked.length === 0 ? (
              <div className="ex-qitem-reason">Ожидающих и заблокированных нет.</div>
            ) : (
              <>
                {waiting.map((item) => (
                  <div key={item.taskId} className="ex-qitem">
                    <div className="ex-qitem-head">
                      <b>Задача {item.taskId}</b>
                      <span className="pf-chip">ожидание</span>
                    </div>
                    <div className="ex-qitem-reason">{reasonLabel(item.reason.code)}</div>
                  </div>
                ))}
                {blocked.map((item) => (
                  <div key={item.taskId} className="ex-qitem">
                    <div className="ex-qitem-head">
                      <b>Задача {item.taskId}</b>
                      <span className="pf-chip">заблокировано</span>
                    </div>
                    <div className="ex-qitem-reason">{reasonLabel(item.reason.code)}</div>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Ёмкость планировщика</h3><span>{usedCapacity}{configuredCapacity !== undefined ? ` / ${configuredCapacity}` : ''}</span></div>
            <div className="ex-limit">
              <div>Используется<div className="pf-progress"><span style={{ width: configuredCapacity && configuredCapacity > 0 ? `${Math.round((usedCapacity / configuredCapacity) * 100)}%` : '0%' }} /></div></div>
              <b>{usedCapacity}{configuredCapacity !== undefined ? ` / ${configuredCapacity}` : ''}</b>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Выбранный запуск</h3><span className="pf-chip">{running[0]?.runId ?? '—'}</span></div>
            <b className="ex-selected-role">{running[0]?.role ?? 'недоступно'}</b>
            <div className="pf-unavail">{running[0]?.taskId ? `TASK: ${running[0].taskId}` : 'недоступно'}</div>
            <div className="ex-selected-actions">
              <button type="button" className="pf-btn" onClick={() => { if (running[0]) window.location.hash = `#/runs/${running[0].runId}`; }}>Открыть</button>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Блокировки ресурсов</h3><span className="pf-chip">{locks.length} активн{locks.length === 1 ? 'а' : 'ы'}</span></div>
            {locks.length === 0 ? (
              <div className="ex-qitem-reason">Блокировок нет.</div>
            ) : locks.map((lock) => (
              <div key={lock.id} className="ex-tool">
                <b>{lock.resource}</b>
                <div className="pf-unavail">Удерживается ресурсом · истекает после завершения</div>
              </div>
            ))}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>События планировщика</h3><span className="pf-chip">в реальном времени</span></div>
            <div className="pf-timeline">
              {events.length === 0 ? (
                <div className="ex-qitem-reason">Событий нет.</div>
              ) : events.map((event) => (
                <div key={event.id} className="pf-event">
                  <b>{event.type}</b>
                  <div>{new Date(event.createdAt).toLocaleString('ru-RU')}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция очереди выполнения v0.1 · причины планировщика явны · скрытого состояния ожидания нет</div>
    </div>
  );
}
