import { useCallback, useState } from 'react';
import { ApiError, apiClient, setDispatchState, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './execution.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const queueStore = createQueryStore();

const RUNS = [
  { title: 'Senior Developer · RUN-841', sub: 'TASK-425 · Anthropic Streaming', chips: ['Ebb AI Hub', 'Hermes', 'Local'], progress: 68, elapsed: '18m 42s' },
  { title: 'Reviewer · RUN-846', sub: 'TASK-426 · Tool Calling', chips: ['Ebb AI Hub', 'Hermes', 'Review'], progress: 41, elapsed: '7m 03s' },
  { title: 'QA Agent · RUN-852', sub: 'TASK-116 · Retry handling', chips: ['xRocket SDK', 'Hermes', 'QA'], progress: 26, elapsed: '3m 21s' },
];

const WAITING = [
  { title: 'Integration Agent · TASK-424', sub: 'Ebb AI Hub · priority: Высокий', reason: 'Ожидает слота роли Integration.', tag: '#1' },
  { title: 'Middle Developer · TASK-429', sub: 'Ebb AI Hub · Документация', reason: 'Достигнут глобальный лимит параллельности.', tag: '#2' },
  { title: 'Senior Developer · TASK-508', sub: 'Ebb Censor Bot · recovery escalation', reason: 'Ожидает согласования бюджета.', tag: '#3' },
  { title: 'QA Agent · TASK-428', sub: 'Ebb AI Hub · integration tests', reason: 'Ожидание зависимостей TASK-425 и TASK-426.', tag: 'заблокировано' },
  { title: 'DevOps Agent · TASK-701', sub: 'Internal tooling · container image', reason: 'Блокировка ресурса: local_docker_environment.', tag: 'lock' },
];

const CAPACITY = [
  { label: 'Разработчики', width: 67, value: '2 / 3' },
  { label: 'Reviewer', width: 100, value: '1 / 1' },
  { label: 'QA', width: 100, value: '1 / 1' },
  { label: 'Integration', width: 0, value: '0 / 1' },
];

const EVENTS = [
  { title: 'Запущен RUN-852', desc: 'Стал доступен слот QA' },
  { title: 'TASK-508 held', desc: 'Достигнут мягкий лимит бюджета' },
  { title: 'TASK-424 reprioritized', desc: 'Применено повышение приоритета для интеграции/разблокировки' },
  { title: 'TASK-428 заблокировано', desc: 'Зависимости не разрешены' },
];

/**
 * Очередь выполнения (reference 05): активные запуски, ожидание, ёмкость,
 * выбранный запуск, блокировки и события планировщика — один в один с макетом.
 * Пауза диспетчеризации и массовая остановка — реальные мутации API.
 */
export default function ExecutionPage() {
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<unknown>(toClientPath('/api/v1/execution'), { signal }), []);
  const query = useQuery(queueStore, '/api/v1/execution', undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const [paused, setPaused] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<unknown | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelAllBusy, setCancelAllBusy] = useState(false);
  const [cancelAllError, setCancelAllError] = useState<unknown | null>(null);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка очереди выполнения…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить очередь выполнения: ${errorMessage(query.error)}`} onRetry={retry} />;

  const pauseQueue = async () => {
    setDispatchBusy(true);
    setDispatchError(null);
    try {
      await setDispatchState(!paused);
      setPaused(!paused);
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
      await apiClient.post(toClientPath('/api/v1/runs/cancel-all'), { expectedRunIds: ['run-841', 'run-846', 'run-852'] });
      setCancelAllOpen(false);
    } catch (error) {
      setCancelAllError(error);
    } finally {
      setCancelAllBusy(false);
    }
  };

  return (
    <div className="reference-screen execution-page">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Очередь выполнения</h1>
          <p>Живое состояние Scheduler, активных Hermes Run и причин, по которым работа ждёт.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn" disabled={dispatchBusy} onClick={() => void pauseQueue()}>
            {paused ? 'Возобновить новую работу' : 'Приостановить new work'}
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
        <div className="pf-metric"><span>Выполняется</span><b>3 / 4</b></div>
        <div className="pf-metric"><span>В очереди</span><b>5</b></div>
        <div className="pf-metric"><span>Blocked</span><b className="ex-warn">2</b></div>
        <div className="pf-metric"><span>Ожидают согласования</span><b>1</b></div>
        <div className="pf-metric"><span>Стоимость this hour</span><b>$2.18</b></div>
      </section>

      <div className="pf-grid ex-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Выполняется now</h3><span className="pf-chip">3 активных запусков</span></div>
            {RUNS.map((run) => (
              <div key={run.title} className="ex-run">
                <div>
                  <b><span className="pf-dot busy" />{run.title}</b>
                  <div className="ex-run-sub">{run.sub}</div>
                  <div className="ex-run-meta">
                    {run.chips.map((chip) => <span key={chip} className="pf-chip">{chip}</span>)}
                  </div>
                  <div className="pf-progress"><span style={{ width: `${run.progress}%` }} /></div>
                </div>
                <div className="ex-run-time">
                  <span className="pf-unavail">прошло</span>
                  <b>{run.elapsed}</b>
                </div>
                <button type="button" className="pf-btn">Открыть</button>
              </div>
            ))}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Очередь ожидания</h3><span className="pf-chip">отсортировано по эффективному приоритету</span></div>
            {WAITING.map((item) => (
              <div key={item.title} className="ex-qitem">
                <div className="ex-qitem-head">
                  <b>{item.title}</b>
                  <span className="pf-chip">{item.tag}</span>
                </div>
                <div className="ex-qitem-sub">{item.sub}</div>
                <div className="ex-qitem-reason">{item.reason}</div>
              </div>
            ))}
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Ёмкость планировщика</h3><span>3 / 4</span></div>
            {CAPACITY.map((row) => (
              <div key={row.label} className="ex-limit">
                <div>{row.label}<div className="pf-progress"><span style={{ width: `${row.width}%` }} /></div></div>
                <b>{row.value}</b>
              </div>
            ))}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Выбранный запуск</h3><span className="pf-chip">RUN-841</span></div>
            <b className="ex-selected-role">Senior Developer</b>
            <div className="pf-unavail">TASK-425 · Anthropic Streaming</div>
            <div className="ex-tool">
              <span className="pf-unavail">Текущее действие</span><br />
              <code>project.test("streaming disconnect")</code>
            </div>
            <div className="ex-tool">
              <span className="pf-unavail">Последнее завершённое действие</span><br />
              <code>workspace.patch(src/providers/anthropic/stream.ts)</code>
            </div>
            <div className="ex-selected-actions">
              <button type="button" className="pf-btn">Приостановить</button>
              <button type="button" className="pf-btn danger">Отменить запуск</button>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Блокировки ресурсов</h3><span className="pf-chip">1 активна</span></div>
            <div className="ex-tool">
              <b>local_docker_environment</b>
              <div className="pf-unavail">Удерживается RUN-849 · истекает после завершения запуска</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>События планировщика</h3><span className="pf-chip">в реальном времени</span></div>
            <div className="pf-timeline">
              {EVENTS.map((event) => (
                <div key={event.title} className="pf-event">
                  <b>{event.title}</b>
                  <div>{event.desc}</div>
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

