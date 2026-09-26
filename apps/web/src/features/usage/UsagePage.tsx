import { useCallback } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';

interface UsageBucket {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokens: number;
  cost: number;
  aggregation: string;
}

interface UsageData {
  global: UsageBucket;
  project: UsageBucket;
  epic: UsageBucket;
  task: UsageBucket;
  effectiveLimit: string;
}

const bucketLabels = [
  ['global', 'Все записи'],
  ['project', 'Записи с project_id'],
  ['epic', 'Записи с epic_id'],
  ['task', 'Записи с task_id'],
] as const;

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

function hasUsage(data: UsageData): boolean {
  return bucketLabels.some(([key]) => data[key].totalTokens > 0 || data[key].cost > 0);
}

/**
 * Отображает только aggregate usage, возвращённый backend.
 * Buckets не являются бюджетными scope: без scope ID UI не показывает лимиты,
 * reservations или effective budget decisions.
 */
export default function UsagePage() {
  const usagePath = toClientPath(apiPaths.usage);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<UsageData>(usagePath, { signal }), [usagePath]);
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
  if (!hasUsage(data)) {
    return <div className="usage-page"><h1>Использование</h1><EmptyState message="Нет доступных записей об использовании." /></div>;
  }

  return (
    <div className="usage-page">
      <h1>Использование</h1>
      <p>Агрегированные показатели только для чтения по достоверным записям использования.</p>
      <section aria-label="Сводные показатели использования" className="metric-grid">
        {bucketLabels.map(([key, label]) => {
          const bucket = data[key];
          return (
            <article key={key} className="table-card">
              <h2>{label}</h2>
              <dl>
                <div><dt>Входные токены</dt><dd>{bucket.inputTokens}</dd></div>
                <div><dt>Кэшированные токены</dt><dd>{bucket.cachedTokens}</dd></div>
                <div><dt>Выходные токены</dt><dd>{bucket.outputTokens}</dd></div>
                <div><dt>Всего токенов</dt><dd>{bucket.totalTokens}</dd></div>
                <div><dt>Стоимость</dt><dd>${bucket.cost.toFixed(2)}</dd></div>
              </dl>
            </article>
          );
        })}
      </section>
    </div>
  );
}
