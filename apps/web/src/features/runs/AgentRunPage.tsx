import { useCallback, useState } from 'react';
import { ApiError, apiClient, createRunCheckpoint, getRunDetail, getRunEventsPage, getRunTerminal, pauseRun, resumeRun, toClientPath } from '../../api/client.js';
import { ErrorAlert, PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { apiPaths } from '@ebb-orchestrator/contracts';
import type { RunDetailProjection, RunEventsPageProjection, RunTerminalProjection } from '@ebb-orchestrator/contracts';
import './runs.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const runStore = createQueryStore();
const eventsStore = createQueryStore();
const terminalStore = createQueryStore();

const TABS = ['В реальном времени', 'Вызовы инструментов', 'Терминал', 'Разрешения', 'Контекст', 'Использование', 'Восстановление'];

/** Русские подписи событий; неузнанные машинные типы отображаются как есть. */
function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'tool-call': 'Начат вызов инструмента',
    'file-change': 'Файл изменён',
    'test-complete': 'Тест завершён',
    'permission-request': 'Запрошено разрешение',
    checkpoint: 'Контрольная точка контекста',
  };
  return labels[type] ?? type;
}

/** Длительность запуска по авторитетным меткам старта/конца; без них — «недоступно». */
function elapsedLabel(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return 'недоступно';
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 'недоступно';
  const seconds = Math.floor((end - start) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Компактное число токенов или «недоступно». */
function tokensLabel(value: { availability: 'available'; value: number } | { availability: string; reason: string } | null | undefined): string {
  if (!value) return 'недоступно';
  if (!('value' in value)) return 'недоступно';
  if (value.value >= 1_000_000) return `${(value.value / 1_000_000).toFixed(1)}M`;
  if (value.value >= 1_000) return `${(value.value / 1_000).toFixed(1)}k`;
  return String(value.value);
}

/**
 * Детализация запуска агента (reference 10): события, терминал, цель, среда,
 * разрешения, использование, восстановление и контекст — данные из backend-проекций;
 * отсутствующие источники рендерятся как «недоступно».
 */
export default function AgentRunPage({ id }: { id: string }) {
  const fetcher = useCallback((signal: AbortSignal) => getRunDetail(id, { signal }), [id]);
  const query = useQuery(runStore, `/api/v1/runs/${id}`, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const run: RunDetailProjection | undefined = query.data;

  const eventsFetcher = useCallback((signal: AbortSignal) => getRunEventsPage(id, { signal }), [id]);
  const eventsQuery = useQuery(eventsStore, `/api/v1/runs/${id}/events`, undefined, eventsFetcher, { enabled: query.status === 'success' });
  const events: RunEventsPageProjection | undefined = eventsQuery.data;

  const terminalFetcher = useCallback((signal: AbortSignal) => getRunTerminal(id, { signal }), [id]);
  const terminalQuery = useQuery(terminalStore, `/api/v1/runs/${id}/terminal`, undefined, terminalFetcher, { enabled: query.status === 'success' });
  const terminal: RunTerminalProjection | undefined = terminalQuery.data;

  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<unknown | null>(null);
  const runControl = useCallback(async (action: () => Promise<unknown>) => {
    setControlBusy(true);
    setControlError(null);
    try {
      await action();
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      setControlError(cause);
    } finally {
      setControlBusy(false);
    }
  }, [query]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка запуска агента…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить запуск агента: ${errorMessage(query.error)}`} onRetry={retry} />;
  if (!run) return <PageState status="empty" message="Данные запуска отсутствуют." />;

  const statusLabel = run.status === 'IN_PROGRESS' ? 'Выполняется' : run.status;
  const control = run.control?.state ?? null;
  const canControl = control === 'ACTIVE' || control === 'PAUSED' || control === 'PAUSE_REQUESTED' || control === 'RESUME_PENDING';

  return (
    <div className="reference-screen agent-run-page reference-screen--run">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>{run.id} · {run.role}</h1>
          <p>{run.taskId ? `TASK: ${run.taskId}` : 'Требование: не указано'} · Hermes session: <b>{run.sessionId ?? 'недоступно'}</b></p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn" disabled={controlBusy || !canControl} onClick={() => void runControl(() => createRunCheckpoint(id))}>Создать контрольную точку</button>
          <button type="button" className="pf-btn" disabled={controlBusy || control !== 'ACTIVE'} onClick={() => void runControl(() => pauseRun(id))}>Приостановить</button>
          {control === 'PAUSED' && (
            <button type="button" className="pf-btn" disabled={controlBusy} onClick={() => void runControl(() => resumeRun(id))}>Возобновить</button>
          )}
          <button type="button" className="pf-btn ru-danger" disabled={controlBusy} onClick={() => void runControl(() => apiClient.post(toClientPath(apiPaths.runCancel(id)), {}))}>Отменить запуск</button>
        </div>
      </div>

      {controlError ? <ErrorAlert message={`Не удалось выполнить действие: ${errorMessage(controlError)}`} /> : null}

      <div className="pf-tabs">
        {TABS.map((tab, index) => (
          <div key={tab} className={`pf-tab${index === 0 ? ' active' : ''}`}>{tab}</div>
        ))}
      </div>

      <section className="ru-metrics" aria-label="Сводка запуска">
        <div className="pf-metric"><span>Статус</span><b><span className={`pf-dot ${run.status === 'IN_PROGRESS' ? 'busy' : 'ok'}`} />{statusLabel}</b></div>
        <div className="pf-metric"><span>Прошло</span><b>{elapsedLabel(run.startedAt, run.endedAt)}</b></div>
        <div className="pf-metric"><span>Вход/кэш/выход</span><b>{tokensLabel(run.usage.inputTokens)} / {tokensLabel(run.usage.cachedInputTokens)} / {tokensLabel(run.usage.outputTokens)}</b></div>
        <div className="pf-metric"><span>Стоимость</span><b>{run.usage.effectiveCost.availability === 'available' ? `$${run.usage.effectiveCost.value.toFixed(2)}` : 'недоступно'}</b></div>
        <div className="pf-metric"><span>Прогресс</span><b className="pf-unavail">недоступно</b></div>
      </section>

      <div className="pf-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Поток событий в реальном времени</h3><span className="pf-chip">автопрокрутка</span></div>
            <div className="ru-timeline">
              {events?.items.length === 0 || !events ? (
                <div className="pf-unavail">История событий недоступна.</div>
              ) : events.items.map((event) => (
                <div key={event.id} className="ru-event">
                  <div className="ru-time">{new Date(event.createdAt).toLocaleTimeString('ru-RU')}</div>
                  <div className="ru-evbody">
                    <b><span className="pf-dot ok" />{eventTypeLabel(event.type)}</b>
                    <small>id: {event.id}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Вывод терминала</h3><span className="pf-unavail">санитизированный поток в реальном времени</span></div>
            {!terminal || terminal.availability !== 'available' ? (
              <div className="pf-unavail">недоступно ({terminal?.reason ?? 'NO_SANITIZED_PERSISTED_SOURCE'})</div>
            ) : (
              <div className="ru-output">
                {terminal.entries.map((entry) => <div key={entry.seq}>{entry.text}</div>)}
              </div>
            )}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Цель запуска</h3><span className="pf-chip">Task Контракт</span></div>
            <div className="pf-kv">
              <div>Цель</div><div>{run.taskId ? `Исполнение задачи ${run.taskId}` : 'недоступно'}</div>
              <div>Триггер</div><div>{run.triggerReason ?? 'недоступно'}</div>
              <div>Попытка</div><div>{run.attempt ?? 'недоступно'}</div>
              <div>Модель</div><div>{run.model || 'недоступно'}</div>
            </div>
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Среда выполнения</h3><span className="pf-chip ru-good">В норме</span></div>
            <div className="pf-kv">
              <div>Среда выполнения</div><div>{run.runtime || 'недоступно'}</div>
              <div>Сессия</div><div>{run.sessionId ?? 'недоступно'}</div>
              <div>Роль</div><div>{run.role}</div>
              <div>Попытка</div><div>{run.attempt ?? 'недоступно'}</div>
              <div>Контроль</div><div>{control ?? 'недоступно'}</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Решения по разрешениям</h3><span className="pf-unavail">этот запуск</span></div>
            <div className="pf-unavail">недоступно (источник решений недоступен в текущей проекции)</div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Использование</h3><span>{run.usage.effectiveCost.availability === 'available' ? `$${run.usage.effectiveCost.value.toFixed(2)}` : 'недоступно'}</span></div>
            <div className="pf-kv">
              <div>Вход</div><div>{tokensLabel(run.usage.inputTokens)}</div>
              <div>Кэшированный вход</div><div>{tokensLabel(run.usage.cachedInputTokens)}</div>
              <div>Выход</div><div>{tokensLabel(run.usage.outputTokens)}</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Сигналы восстановления</h3><span className="pf-chip ru-good">Циклов нет</span></div>
            <div className="pf-kv">
              <div>Прогресс</div><div className="pf-unavail">недоступно</div>
              <div>Повторная ошибка</div><div className="pf-unavail">недоступно</div>
              <div>Контрольная точка</div><div>{run.control?.checkpointId ?? 'недоступно'}</div>
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция детализации запуска агента v0.1 · техническая наблюдаемость без раскрытия секретов и расширения контроля Hermes</div>
    </div>
  );
}
