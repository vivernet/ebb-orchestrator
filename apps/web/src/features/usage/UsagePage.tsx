import { useCallback } from 'react';
import { apiPaths, type UsageBudgetContextProjection, type UsageBudgetLimitProjection, type UsagePageProjection } from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';

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

function hasUsage(data: UsagePageProjection): boolean {
  const hasMetrics = metricBucketLabels.some(([key]) => data[key].totalTokens > 0 || data[key].cost > 0);
  return hasMetrics || data.budget.configurations.length > 0 || data.budget.activeReservations.length > 0;
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

/** Отображает авторитетные usage metrics и read-only состояние иерархических бюджетов. */
export default function UsagePage() {
  const usagePath = toClientPath(apiPaths.usage);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<UsagePageProjection>(usagePath, { signal }), [usagePath]);
  const query = useQuery(null, usagePath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  useOnSSEReconnect(refresh);

  if (!query.data && (query.status === 'idle' || query.status === 'loading')) {
    return <PageState status="loading" message="Загрузка данных об использовании…" />;
  }

  if (query.status === 'error') {
    return <PageState status="error" message={`Не удалось загрузить данные об использовании: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  if (!query.data) {
    return <PageState status="error" message="Данные об использовании недоступны." onRetry={retry} />;
  }

  const data = query.data;
  const contextsWithEffectiveLimit = data.budget.contexts.flatMap((context) => context.effectiveLimit
    ? [{ context, limit: context.effectiveLimit }]
    : []);
  if (!hasUsage(data)) {
    return <div className="usage-page"><h1>Использование</h1><EmptyState message="Нет данных об использовании, лимитов бюджета или активных резервирований." /></div>;
  }

  return (
    <div className="usage-page">
      <h1>Использование</h1>
      <p>Агрегированные показатели и состояние бюджетов доступны только для чтения.</p>
      <section aria-label="Сводные показатели использования" className="metric-grid">
        {metricBucketLabels.map(([key, label]) => {
          const bucket = data[key];
          return (
            <article key={key} className="table-card">
              <h2>{label}</h2>
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
      </section>

      <section aria-labelledby="usage-budget-heading">
        <h2 id="usage-budget-heading">Лимиты бюджета</h2>
        {data.budget.configurations.length === 0 ? (
          <p>Настроенных лимитов нет.</p>
        ) : (
          <div className="table-card">
            <table>
              <caption>Сохранённые конфигурации лимитов</caption>
              <thead><tr><th scope="col">Область</th><th scope="col">ID области</th><th scope="col">Лимит</th><th scope="col">Мягкий лимит</th><th scope="col">Политика</th><th scope="col">Потрачено</th><th scope="col">Зарезервировано</th></tr></thead>
              <tbody>
                {data.budget.configurations.map((config) => (
                  <tr key={`${config.scope}:${config.scopeId}`}>
                    <td>{scopeLabels[config.scope]}</td><td><code>{config.scopeId}</code></td>
                    <td>{formatCost(config.limitCost)}</td><td>{formatCost(config.softLimitCost)}</td>
                    <td>{formatPolicy(config.policy)}</td><td>{formatCost(config.spentCost)}</td><td>{formatCost(config.reservedCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>Эффективный ограничивающий лимит</h3>
        {contextsWithEffectiveLimit.length === 0 ? (
          <p>Для доступных областей эффективный лимит не настроен.</p>
        ) : (
          <div className="table-card">
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
        )}
      </section>

      <section aria-labelledby="usage-reservations-heading">
        <h2 id="usage-reservations-heading">Текущие резервирования</h2>
        {data.budget.activeReservations.length === 0 ? (
          <p>Активных резервирований нет.</p>
        ) : (
          <div className="table-card">
            <table>
              <caption>Записи со статусом RESERVED</caption>
              <thead><tr><th scope="col">ID</th><th scope="col">Проект</th><th scope="col">Эпик</th><th scope="col">Задача</th><th scope="col">Оценка</th><th scope="col">Роль / модель</th><th scope="col">Причина запуска</th><th scope="col">Создано</th></tr></thead>
              <tbody>
                {data.budget.activeReservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td><code>{reservation.id}</code></td><td><code>{reservation.projectId}</code></td>
                    <td>{reservation.epicId ? <code>{reservation.epicId}</code> : '—'}</td>
                    <td>{reservation.taskId ? <code>{reservation.taskId}</code> : '—'}</td>
                    <td>{formatCost(reservation.estimateCost)}</td><td>{reservation.role} / {reservation.model}</td>
                    <td>{reservation.triggerReason}{reservation.reworkCategory ? ` · ${reservation.reworkCategory}` : ''}</td>
                    <td>{reservation.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
