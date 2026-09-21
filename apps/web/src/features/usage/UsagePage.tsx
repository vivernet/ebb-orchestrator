import { useCallback, useMemo } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { apiClient, toClientPath } from '../../api/client.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

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
  ['global', 'All records'],
  ['project', 'Records with project_id'],
  ['epic', 'Records with epic_id'],
  ['task', 'Records with task_id'],
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
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
  const store = useMemo(() => createQueryStore(), []);
  const usagePath = toClientPath(apiPaths.usage);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<UsageData>(usagePath, { signal }), [usagePath]);
  const query = useQuery(store, usagePath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  useOnSSEReconnect(refresh);

  if (!query.data && (query.status === 'idle' || query.status === 'loading')) {
    return <div className="page-state">Loading usage data…</div>;
  }

  if (query.status === 'error') {
    return <div className="page-state" role="alert"><p>Unable to load usage: {errorMessage(query.error)}</p><button type="button" onClick={retry}>Retry</button></div>;
  }

  if (!query.data) {
    return <div className="page-state" role="alert"><p>Usage data is unavailable.</p><button type="button" onClick={retry}>Retry</button></div>;
  }

  const data = query.data;
  if (!hasUsage(data)) {
    return <div className="usage-page"><h1>Usage</h1><p className="empty-state">No usage records are available.</p></div>;
  }

  return (
    <div className="usage-page">
      <h1>Usage</h1>
      <p>Read-only aggregate metrics from authoritative usage records.</p>
      <section aria-label="Usage aggregates" className="metric-grid">
        {bucketLabels.map(([key, label]) => {
          const bucket = data[key];
          return (
            <article key={key} className="table-card">
              <h2>{label}</h2>
              <dl>
                <div><dt>Input tokens</dt><dd>{bucket.inputTokens}</dd></div>
                <div><dt>Cached tokens</dt><dd>{bucket.cachedTokens}</dd></div>
                <div><dt>Output tokens</dt><dd>{bucket.outputTokens}</dd></div>
                <div><dt>Total tokens</dt><dd>{bucket.totalTokens}</dd></div>
                <div><dt>Cost</dt><dd>${bucket.cost.toFixed(2)}</dd></div>
              </dl>
            </article>
          );
        })}
      </section>
    </div>
  );
}
