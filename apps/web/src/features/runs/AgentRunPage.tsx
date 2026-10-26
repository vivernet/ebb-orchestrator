import { useCallback } from 'react';
import { ApiError, apiClient, getRunDetail, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import './runs.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const runStore = createQueryStore();

const TABS = ['В реальном времени', 'Вызовы инструментов', 'Терминал', 'Разрешения', 'Контекст', 'Использование', 'Восстановление'];

const EVENTS = [
  { time: '06:18:43', dot: 'busy', title: 'Начат вызов инструмента', small: 'project.test', code: 'project.test("streaming disconnect")' },
  { time: '06:18:12', dot: 'ok', title: 'Файл изменён', small: 'Permission Engine: ALLOW', code: 'workspace.patch(\n  "src/providers/anthropic/stream.ts"\n)' },
  {
    time: '06:17:54', dot: 'ok', title: 'Тест завершён', small: '1 ошибка → 0 ошибок в выбранном файле тестов',
    output: 'PASS src/providers/anthropic/stream.test.ts\nTests: 14 passed, 14 total\nDuration: 2.84s',
  },
  { time: '06:16:31', dot: 'wait', title: 'Запрошено разрешение', small: 'Для универсальной команды требуется явное согласование', code: 'command.run("pnpm vitest --runInBand stream.disconnect.test.ts")', oneTime: true },
  { time: '06:15:08', dot: 'ok', title: 'Контрольная точка контекста', small: 'Обнаружен осмысленный прогресс · продолжается та же сессия' },
];

const PERMISSIONS = [
  { tool: 'workspace.patch', sub: 'внутри рабочего дерева задачи', kind: 'ALLOW', tone: 'good' },
  { tool: 'project.test', sub: 'настроенное действие проекта', kind: 'ALLOW', tone: 'good' },
  { tool: 'command.run', sub: 'универсальная команда vitest', kind: 'РАЗРЕШИТЬ ОДИН РАЗ', tone: 'warn' },
  { tool: 'git.push', sub: 'роль разработчика', kind: 'DENY', tone: 'bad' },
];

/**
 * Детализация запуска агента (reference 10): события, терминал, цель, среда,
 * разрешения, использование, восстановление и контекст — один в один с макетом.
 */
export default function AgentRunPage({ id }: { id: string }) {
  const fetcher = useCallback(() => getRunDetail(id), [id]);
  const query = useQuery(runStore, `/api/v1/runs/${id}`, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка запуска агента…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить запуск агента: ${errorMessage(query.error)}`} onRetry={retry} />;

  return (
    <div className="reference-screen agent-run-page">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>RUN-841 · Senior Developer</h1>
          <p>TASK-425 · Anthropic Streaming · Hermes session: <b>dev-425</b></p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn">Создать контрольную точку</button>
          <button type="button" className="pf-btn">Приостановить</button>
          <button type="button" className="pf-btn ru-danger">Отменить запуск</button>
        </div>
      </div>

      <div className="pf-tabs">
        {TABS.map((tab, index) => (
          <div key={tab} className={`pf-tab${index === 0 ? ' active' : ''}`}>{tab}</div>
        ))}
      </div>

      <section className="ru-metrics" aria-label="Сводка запуска">
        <div className="pf-metric"><span>Статус</span><b><span className="pf-dot busy" />Выполняется</b></div>
        <div className="pf-metric"><span>Прошло</span><b>18m 42s</b></div>
        <div className="pf-metric"><span>Вызовы инструментов</span><b>37</b></div>
        <div className="pf-metric"><span>Токены</span><b>74.2k</b></div>
        <div className="pf-metric"><span>Стоимость</span><b>$0.78</b></div>
        <div className="pf-metric"><span>Прогресс</span><b>68%</b></div>
      </section>

      <div className="pf-grid">
        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Поток событий в реальном времени</h3><span className="pf-chip">автопрокрутка</span></div>
            <div className="ru-timeline">
              {EVENTS.map((event) => (
                <div key={event.time} className="ru-event">
                  <div className="ru-time">{event.time}</div>
                  <div className="ru-evbody">
                    <b><span className={`pf-dot ${event.dot}`} />{event.title}</b>
                    {event.small && <small>{event.small}</small>}
                    {event.code && <div className="ru-toolcall"><code>{event.code}</code></div>}
                    {event.output && <div className="ru-output">{event.output}</div>}
                    {event.oneTime && <div style={{ marginTop: '7px' }}><span className="pf-chip ru-good">Разрешено пользователем один раз</span></div>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Вывод терминала</h3><span className="pf-unavail">санитизированный поток в реальном времени</span></div>
            <div className="ru-output">{`$ pnpm test streaming disconnect

> ebb-ai-hub@0.4.0 test
> vitest run ...

✓ stream handles normal completion
✓ stream maps provider errors
✓ disconnect aborts reader
✓ timeout propagates normalized error

Test Files  1 passed
Tests       14 passed
Duration    2.84s`}</div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Цель запуска</h3><span className="pf-chip">Task Контракт</span></div>
            <div className="pf-kv">
              <div>Цель</div><div>Исправить особые случаи disconnect/reconnect до передачи в QA.</div>
              <div>Триггер</div><div>REVIEW_REWORK</div>
              <div>Ожидаемый результат</div><div>Изменения кода + успешные целевые тесты + краткий отчёт о завершении.</div>
              <div>Рабочее пространство</div><div>task/425-anthropic-streaming</div>
            </div>
          </section>
        </div>

        <div>
          <section className="pf-card">
            <div className="pf-row"><h3>Среда выполнения</h3><span className="pf-chip ru-good">В норме</span></div>
            <div className="pf-kv">
              <div>Среда выполнения</div><div>Hermes</div>
              <div>Сессия</div><div>dev-425</div>
              <div>Выполнение</div><div>Local</div>
              <div>Роль</div><div>Senior Developer</div>
              <div>Попытка</div><div>2</div>
              <div>Возобновление</div><div className="ru-good">Да · предыдущая сессия</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Решения по разрешениям</h3><span className="pf-unavail">этот запуск</span></div>
            {PERMISSIONS.map((row) => (
              <div key={row.tool} className="ru-permission">
                <div><b>{row.tool}</b><div className="pf-unavail">{row.sub}</div></div>
                <span className={`pf-chip ru-${row.tone}`}>{row.kind}</span>
              </div>
            ))}
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Использование</h3><span>$0.78</span></div>
            <div className="pf-kv">
              <div>Вход</div><div>63.4k</div>
              <div>Кэшированный вход</div><div>42.1k</div>
              <div>Выход</div><div>10.8k</div>
              <div>Доля кэша</div><div>66%</div>
            </div>
            <div className="pf-progress"><span style={{ width: '39%' }} /></div>
            <div className="pf-unavail">Мягкий бюджет задачи: $2.00 · текущие расходы задачи: $0.78</div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Сигналы восстановления</h3><span className="pf-chip ru-good">Циклов нет</span></div>
            <div className="pf-kv">
              <div>Прогресс</div><div className="ru-good">Осмысленный</div>
              <div>Повторная ошибка</div><div>No</div>
              <div>Цикл одной команды</div><div>No</div>
              <div>Эскалация</div><div>Не требуется</div>
              <div>Контрольная точка</div><div>06:15:08</div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-row"><h3>Пакет контекста</h3><span className="pf-chip">31.8k токенов</span></div>
            <div className="pf-kv">
              <div>Контракт задачи</div><div>включён</div>
              <div>Проверка результатов</div><div>2 нерешённых → теперь решены</div>
              <div>Сводка эпика</div><div>включён</div>
              <div>Рекомендации</div><div>архитектура + git</div>
              <div>Дамп репозитория</div><div className="ru-good">не включён</div>
            </div>
          </section>
        </div>
      </div>

      <div className="pf-footer-note">Концепция детализации запуска агента v0.1 · техническая наблюдаемость без раскрытия секретов и расширения контроля Hermes</div>
    </div>
  );
}

