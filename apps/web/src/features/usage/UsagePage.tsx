import { useCallback, useState } from 'react';
import {
  apiPaths,
  type UsageBudgetContextProjection,
  type UsageBudgetLimitProjection,
  type UsagePageProjection,
  type UsageWindowProjection,
  usageWindowProjectionSchema,
} from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, getUsageWindow, toClientPath } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, ru } from '../../i18n/ru.js';

const metricBucketLabels = [
  ['global', 'Все записи'],
  ['project', 'Записи с project_id'],
  ['epic', 'Записи с epic_id'],
  ['task', 'Записи с task_id'],
] as const;

const scopeLabels = {
  global: 'Глобально',
  project: 'Проект',
  epic: 'Эпик',
  task: 'Задача',
} as const;

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatPolicy(policy: UsageBudgetLimitProjection['policy']): string {
  return policy === 'hard' ? 'Жёсткая (hard)' : 'Мягкая (soft)';
}

function budgetContextLabel(context: UsageBudgetContextProjection): string {
  return `${scopeLabels[context.scope]} · ${context.scopeId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type UsageView = { kind: 'legacy'; data: UsagePageProjection } | { kind: 'window'; data: UsageWindowProjection };

function normalizeUsagePayload(raw: unknown): UsageView {
  const typed = usageWindowProjectionSchema.safeParse(raw);
  if (typed.success) return { kind: 'window', data: typed.data };
  if (isRecord(raw) && 'global' in raw && 'budget' in raw) {
    return { kind: 'legacy', data: raw as unknown as UsagePageProjection };
  }
  throw new ApiError(ru.errors.default, 0, 'INVALID_RESPONSE');
}

function hasLegacyUsage(data: UsagePageProjection): boolean {
  const hasMetrics = metricBucketLabels.some(([key]) => {
    const bucket = (data as unknown as Record<string, UsagePageProjection['global']>)[key];
    return bucket !== undefined && (bucket.totalTokens > 0 || bucket.cost > 0);
  });
  return hasMetrics || data.budget.configurations.length > 0 || data.budget.activeReservations.length > 0;
}

function isoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function availabilityText(value: { availability: 'available'; value: number } | { availability: 'unavailable'; reason: string }): string {
  return value.availability === 'available' ? formatNumber(value.value) : 'Недоступно';
}

/** Отображает авторитетные usage метрики по UTC-окну и read-only состояние бюджетов. */
export default function UsagePage() {
  const usagePath = toClientPath(apiPaths.usage);
  const now = new Date();
  const fromDefault = isoDateUtc(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const toDefault = isoDateUtc(now);
  const [from, setFrom] = useState(fromDefault);
  const [to, setTo] = useState(toDefault);
  const [granularity, setGranularity] = useState<'day' | 'hour' | 'month'>('day');
  // Детерминированное UTC-окно по умолчанию (последние 30 суток): страница
  // всегда запрашивает авторитетную проекцию /usage?from&to вместо legacy-пути,
  // чтобы не попадать в load-error при отсутствии выбранного окна.
  const [windowQuery, setWindowQuery] = useState<{ from: string; to: string; granularity: 'day' | 'hour' | 'month' } | null>(() => ({
    from: `${fromDefault}T00:00:00.000Z`,
    to: `${toDefault}T23:59:59.999Z`,
    granularity: 'day',
  }));

  const path = windowQuery ? toClientPath(apiPaths.usageWindow(windowQuery.from, windowQuery.to, windowQuery.granularity)) : usagePath;
  const fetcher = useCallback((signal: AbortSignal): Promise<UsageView> => {
    if (!windowQuery) {
      return apiClient.get<unknown>(usagePath, { signal }).then(normalizeUsagePayload);
    }
    void signal;
    return getUsageWindow(windowQuery.from, windowQuery.to, windowQuery.granularity).then((data) => ({ kind: 'window', data }));
  }, [usagePath, windowQuery]);

  const query = useQuery(null, path, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  if (!query.data && (query.status === 'idle' || query.status === 'loading')) {
    return <PageState status="loading" message="Загрузка данных об использовании…" />;
  }

  if (query.status === 'error') {
    return <PageState status="error" message={`Не удалось загрузить данные об использовании: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  if (!query.data) {
    return <PageState status="error" message="Данные об использовании недоступны." onRetry={retry} />;
  }

  const view = query.data;

  if (view.kind === 'legacy' && !hasLegacyUsage(view.data)) {
    return (
      <div className="usage-page reference-screen reference-screen--usage">
        <h1>Использование</h1>
        <EmptyState message="Нет данных об использовании, лимитов бюджета или активных резервирований." />
      </div>
    );
  }

  const budgets = view.kind === 'legacy' ? view.data.budget : view.data.budgets;
  const contextsWithEffectiveLimit = budgets.contexts.flatMap((context) => context.effectiveLimit
    ? [{ context, limit: context.effectiveLimit }]
    : []);

  return (
    <div className="usage-page page-stack reference-screen reference-screen--usage">
      <div className="topbar">
        <div>
          <h1>Использование и бюджет</h1>
          <div className="sub">Период выбирается в UTC; значения берутся из persisted usage-записей.</div>
        </div>
        <div className="top-actions">
          <a className="btn-ghost" href="/settings">Политики бюджета</a>
        </div>
      </div>

      <form className="usage-window-bar" onSubmit={(event) => {
        event.preventDefault();
        if (from && to && from <= to) setWindowQuery({ from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z`, granularity });
      }}>
        <label>
          Начало периода (UTC)
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          Конец периода (UTC)
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label>
          Детализация
          <select value={granularity} onChange={(event) => setGranularity(event.target.value as 'day' | 'hour' | 'month')}>
            <option value="day">День</option>
            <option value="hour">Час</option>
            <option value="month">Месяц</option>
          </select>
        </label>
        <button type="submit" className="btn-primary">Применить окно</button>
      </form>

      {view.kind === 'window' ? (
        <WindowUsageView data={view.data} budgets={budgets} contextsWithEffectiveLimit={contextsWithEffectiveLimit} />
      ) : (
        <LegacyUsageView data={view.data} contextsWithEffectiveLimit={contextsWithEffectiveLimit} />
      )}
    </div>
  );
}

function LegacyUsageView({ data, contextsWithEffectiveLimit }: {
  data: UsagePageProjection;
  contextsWithEffectiveLimit: Array<{ context: UsageBudgetContextProjection; limit: UsageBudgetLimitProjection }>;
}) {
  return (
    <>
      <section className="reference-metrics" aria-label="Сводка использования">
        <div className="reference-metric"><span>Токены</span><strong>{data.global.totalTokens.toLocaleString('ru-RU')}</strong><small>{`вход ${data.global.inputTokens} · кэш ${data.global.cachedTokens} · выход ${data.global.outputTokens}`}</small></div>
        <div className="reference-metric"><span>Израсходовано</span><strong>{formatCost(data.global.cost)}</strong><small>{data.budget.configurations.length > 0 ? `лимитов: ${data.budget.configurations.length}` : 'лимиты не настроены'}</small></div>
        <div className="reference-metric"><span>Активные резервирования</span><strong>{data.budget.activeReservations.length}</strong></div>
      </section>

      <section className="reference-panel" aria-label="Сводные показатели использования">
        <div className="section-heading"><h2>Использование по областям</h2><p>Группировка записей отражает scope, указанный в read model.</p></div>
        <div className="usage-scope-grid">
        {metricBucketLabels.map(([key, label]) => {
          const bucket = data[key];
          return (
            <article key={key} className="usage-scope">
              <h3>{label}</h3>
              <dl>
                <div><dt>Входные токены</dt><dd>{bucket.inputTokens}</dd></div>
                <div><dt>Кэшированные токены</dt><dd>{bucket.cachedTokens}</dd></div>
                <div><dt>Выходные токены</dt><dd>{bucket.outputTokens}</dd></div>
                <div><dt>Всего токенов</dt><dd>{bucket.totalTokens}</dd></div>
                <div><dt>Стоимость</dt><dd>{formatCost(bucket.cost)}</dd></div>
              </dl>
            </article>
          );
        })}
        </div>
      </section>

      <BudgetTables budgets={data.budget} contextsWithEffectiveLimit={contextsWithEffectiveLimit} />
    </>
  );
}

function WindowUsageView({ data, budgets, contextsWithEffectiveLimit }: {
  data: UsageWindowProjection;
  budgets: UsageWindowProjection['budgets'];
  contextsWithEffectiveLimit: Array<{ context: UsageBudgetContextProjection; limit: UsageBudgetLimitProjection }>;
}) {
  return (
    <>
      <section className="reference-metrics" aria-label="Сводка использования">
        <div className="reference-metric"><span>Токены</span><strong>{data.summary.totalTokens.toLocaleString('ru-RU')}</strong><small>{`вход ${data.summary.inputTokens} · кэш ${data.summary.cachedTokens} · выход ${data.summary.outputTokens}`}</small></div>
        <div className="reference-metric"><span>Израсходовано</span><strong>{formatCost(data.summary.cost)}</strong></div>
        <div className="reference-metric"><span>Активные резервирования</span><strong>{budgets.activeReservations.length}</strong></div>
      </section>

      <section className="reference-panel" aria-label="Дневная серия">
        <div className="section-heading"><h2>Дневная серия</h2></div>
        {data.dailySeries.length === 0 ? <EmptyState message="За период записей нет." /> : (
          <ul className="reference-record-list">
            {data.dailySeries.map((day) => (
              <li key={day.date}>
                <strong>{day.date}</strong>
                <span>{day.usage.totalTokens.toLocaleString('ru-RU')} токенов · {formatCost(day.usage.cost)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="reference-columns usage-columns">
        <section className="reference-panel" aria-label="Расходы по ролям">
          <div className="section-heading"><h2>Расходы по ролям</h2></div>
          {data.breakdowns.byRole.length === 0 ? <p>Записей нет.</p> : (
            <table className="table-card"><thead><tr><th>Роль</th><th>Spend</th><th>Доля</th><th>Запуски</th></tr></thead><tbody>
              {data.breakdowns.byRole.map((entry) => (
                <tr key={entry.key}><td>{entry.key}</td><td>{formatCost(entry.spend)}</td><td>{(entry.share * 100).toFixed(0)}%</td><td>{entry.runCount}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="reference-panel" aria-label="Расходы по причине">
          <div className="section-heading"><h2>Расходы по причине</h2></div>
          {data.breakdowns.byReason.length === 0 ? <p>Записей нет.</p> : (
            <ul className="reference-record-list">
              {data.breakdowns.byReason.map((entry) => (
                <li key={entry.key}><strong>{entry.key}</strong><span>{formatCost(entry.spend)} · {(entry.share * 100).toFixed(0)}%</span></li>
              ))}
            </ul>
          )}
        </section>

        <section className="reference-panel" aria-label="Расходы по моделям">
          <div className="section-heading"><h2>Расходы по моделям</h2></div>
          {data.breakdowns.byModel.length === 0 ? <p>Записей нет.</p> : (
            <table className="table-card"><thead><tr><th>Модель</th><th>Spend</th><th>Доля</th><th>Запуски</th></tr></thead><tbody>
              {data.breakdowns.byModel.map((entry) => (
                <tr key={entry.key}><td>{entry.key}</td><td>{formatCost(entry.spend)}</td><td>{(entry.share * 100).toFixed(0)}%</td><td>{entry.runCount}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="reference-panel" aria-label="Сравнение моделей">
          <div className="section-heading"><h2>Сравнение моделей</h2></div>
          {data.modelComparison.length === 0 ? <p>Записей нет.</p> : (
            <table className="table-card"><thead><tr><th>Роль/модель</th><th>Средняя стоимость</th><th>Запуски</th></tr></thead><tbody>
              {data.modelComparison.map((entry) => (
                <tr key={`${entry.role}:${entry.model}`}><td>{entry.role} / {entry.model}</td><td>{formatCost(entry.averageCostPerRun)}</td><td>{entry.runs}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="reference-panel" aria-label="Эффективность">
          <div className="section-heading"><h2>Эффективность</h2></div>
          <dl className="approval-facts">
            <div><dt>Кэшированный вход</dt><dd>{availabilityText(data.efficiency.cacheShare)}</dd></div>
            <div><dt>Avg initial context</dt><dd>{availabilityText(data.efficiency.averageInitialContextTokens)}</dd></div>
            <div><dt>Avg output</dt><dd>{availabilityText(data.efficiency.averageOutputTokens)}</dd></div>
            <div><dt>AI runs/task</dt><dd>{availabilityText(data.efficiency.aiRunsPerTask)}</dd></div>
            <div><dt>Rework cycles/task</dt><dd>{availabilityText(data.efficiency.reworkCyclesPerTask)}</dd></div>
            <div><dt>Детерминированные проверки</dt><dd>{availabilityText(data.efficiency.deterministicCheckCount)}</dd></div>
            <div><dt>Стоимость проверок</dt><dd>{availabilityText(data.efficiency.deterministicCheckCost)}</dd></div>
          </dl>
        </section>

        <section className="reference-panel" aria-label="Аномалии стоимости">
          <div className="section-heading"><h2>Аномалии стоимости</h2></div>
          <p className="reference-callout">{data.anomaly.availability === 'available' ? `Значение: ${formatCost(data.anomaly.value)}` : 'Аномалии стоимости недоступны: нет одобренной evidence-backed политики классификации.'}</p>
        </section>

        <section className="reference-panel" aria-label="Доля восстановления задач">
          <div className="section-heading"><h2>Доля восстановления задач</h2></div>
          <p className="reference-callout">{data.taskRecoveryShare.availability === 'available' ? `Значение: ${formatNumber(data.taskRecoveryShare.value)}` : 'Доля восстановления задач недоступна: нет одобренной evidence-backed политики классификации.'}</p>
        </section>
      </div>

      <BudgetTables budgets={budgets} contextsWithEffectiveLimit={contextsWithEffectiveLimit} />
    </>
  );
}

function BudgetTables({ budgets, contextsWithEffectiveLimit }: {
  budgets: { configurations: UsageBudgetLimitProjection[]; contexts: UsageBudgetContextProjection[]; activeReservations: UsageWindowProjection['budgets']['activeReservations'] };
  contextsWithEffectiveLimit: Array<{ context: UsageBudgetContextProjection; limit: UsageBudgetLimitProjection }>;
}) {
  return (
    <div className="reference-columns usage-columns">
      <section className="reference-panel" aria-labelledby="usage-budget-heading">
        <h2 id="usage-budget-heading">Лимиты бюджета</h2>
        {budgets.configurations.length === 0 ? (
          <p>Настроенных лимитов нет.</p>
        ) : (
          <div className="table-card"><div className="table-scroll">
            <table>
              <caption>Сохранённые конфигурации лимитов</caption>
              <thead><tr><th scope="col">Область</th><th scope="col">ID области</th><th scope="col">Лимит</th><th scope="col">Мягкий лимит</th><th scope="col">Политика</th><th scope="col">Потрачено</th><th scope="col">Зарезервировано</th></tr></thead>
              <tbody>
                {budgets.configurations.map((config) => (
                  <tr key={`${config.scope}:${config.scopeId}`}>
                    <td>{scopeLabels[config.scope]}</td><td><code>{config.scopeId}</code></td>
                    <td>{formatCost(config.limitCost)}</td><td>{formatCost(config.softLimitCost)}</td>
                    <td>{formatPolicy(config.policy)}</td><td>{formatCost(config.spentCost)}</td><td>{formatCost(config.reservedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}

        <h3>Эффективный ограничивающий лимит</h3>
        {contextsWithEffectiveLimit.length === 0 ? (
          <p>Для доступных областей эффективный лимит не настроен.</p>
        ) : (
          <div className="table-card"><div className="table-scroll">
            <table>
              <caption>Наиболее строгая применимая конфигурация для каждой области</caption>
              <thead><tr><th scope="col">Контекст</th><th scope="col">Применимые области</th><th scope="col">Ограничивающая конфигурация</th><th scope="col">Лимит</th><th scope="col">Политика этой конфигурации</th></tr></thead>
              <tbody>
                {contextsWithEffectiveLimit.map(({ context, limit }) => (
                  <tr key={`${context.scope}:${context.scopeId}`}>
                    <td>{budgetContextLabel(context)}</td>
                    <td>{context.applicableLimits.map((applicable) => `${scopeLabels[applicable.scope]} (${applicable.scopeId})`).join(', ')}</td>
                    <td>{scopeLabels[limit.scope]} (<code>{limit.scopeId}</code>)</td>
                    <td>{formatCost(limit.limitCost)}</td>
                    <td>{formatPolicy(limit.policy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}
      </section>

      <section className="reference-panel" aria-labelledby="usage-reservations-heading">
        <h2 id="usage-reservations-heading">Текущие резервирования</h2>
        {budgets.activeReservations.length === 0 ? (
          <p>Активных резервирований нет.</p>
        ) : (
          <div className="table-card"><div className="table-scroll">
            <table>
              <caption>Записи со статусом RESERVED</caption>
              <thead><tr><th scope="col">ID</th><th scope="col">Проект</th><th scope="col">Эпик</th><th scope="col">Задача</th><th scope="col">Оценка</th><th scope="col">Роль / модель</th><th scope="col">Причина запуска</th><th scope="col">Создано</th></tr></thead>
              <tbody>
                {budgets.activeReservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td><code>{reservation.id}</code></td><td>{reservation.projectId ? <a href={`/projects/${encodeURIComponent(reservation.projectId)}`}><code>{reservation.projectId}</code></a> : '—'}</td>
                    <td>{reservation.epicId ? <a href={`/epics/${encodeURIComponent(reservation.epicId)}`}><code>{reservation.epicId}</code></a> : '—'}</td>
                    <td>{reservation.taskId ? <a href={`/tasks/${encodeURIComponent(reservation.taskId)}`}><code>{reservation.taskId}</code></a> : '—'}</td>
                    <td>{formatCost(reservation.estimateCost)}</td><td>{reservation.role} / {reservation.model}</td>
                    <td>{reservation.triggerReason}{reservation.reworkCategory ? ` · ${reservation.reworkCategory}` : ''}</td>
                    <td>{reservation.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}
      </section>
    </div>
  );
}
