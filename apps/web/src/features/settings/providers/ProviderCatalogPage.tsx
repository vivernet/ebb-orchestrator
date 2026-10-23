/**
 * Каталог ИИ-провайдеров (plan-24, Task 6): список всех 86 записей с
 * поиском, фильтром по категории и статусным бейджем. Без секретов/endpoint.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ProviderCatalogEntryProjection, ProviderSettingsProjection } from '@ebb-orchestrator/contracts';
import { PageState } from '../../../components/ui/PageState.js';
import { useQuery } from '../../../state/use-query.js';
import { apiErrorMessage, ru } from '../../../i18n/ru.js';
import { getProviderCatalog, getProviderStatuses } from './provider-api.js';
import { ProviderStatusBadge, providerStatusView } from './ProviderStatus.js';
import '../../../styles/provider.css';

const CATEGORIES = ['all', 'chat', 'image', 'video', 'embedding', 'platform', 'gateway', 'local'] as const;

/** Страница каталога всех 86 провайдеров с поиском, фильтром и статусами. */
export default function ProviderCatalogPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');

  const catalogFetcher = useCallback((_signal: AbortSignal) => getProviderCatalog().then((p) => p.providers), []);
  const catalogQuery = useQuery(null, '/api/v1/providers/catalog', undefined, catalogFetcher);
  const statusesFetcher = useCallback((_signal: AbortSignal) => getProviderStatuses(), []);
  const statusesQuery = useQuery(null, '/api/v1/providers/status', undefined, statusesFetcher);

  const retry = useCallback(() => {
    void catalogQuery.refetch().catch(() => undefined);
    void statusesQuery.refetch().catch(() => undefined);
  }, [catalogQuery.refetch, statusesQuery.refetch]);

  const statusByProvider = useMemo(() => {
    const map = new Map<string, ProviderSettingsProjection>();
    for (const status of statusesQuery.data?.providers ?? []) map.set(status.providerId, status);
    return map;
  }, [statusesQuery.data]);

  const queryFailed = catalogQuery.status === 'error' || statusesQuery.status === 'error';
  const loading = catalogQuery.status === 'loading' || catalogQuery.status === 'idle' || statusesQuery.status === 'loading' || statusesQuery.status === 'idle';

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const providers = catalogQuery.data ?? [];
    if (providers.length === 0) return providers;
    return providers.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (term.length > 0) {
        const haystack = `${entry.displayName} ${entry.id}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [catalogQuery.data, search, category]);

  if (loading) return <PageState status="loading" message={ru.providers.pageTitle} />;
  if (queryFailed) {
    return (
      <PageState
        status="error"
        title={ru.providers.pageTitle}
        message={`Не удалось загрузить каталог провайдеров: ${apiErrorMessage(catalogQuery.error instanceof Error && 'code' in catalogQuery.error ? String((catalogQuery.error as { code?: string }).code) : undefined)}`}
        onRetry={retry}
      />
    );
  }

  return (
    <div className="provider-catalog-page page-stack">
      <header className="page-header">
        <div><p className="eyebrow">Настройки</p><h1>{ru.providers.pageTitle}</h1></div>
      </header>
      <p>{ru.providers.catalogIntro}</p>

      <div className="provider-toolbar">
        <label>
          <span className="visually-hidden">{ru.providers.searchPlaceholder}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={ru.providers.searchPlaceholder}
            aria-label={ru.providers.searchPlaceholder}
          />
        </label>
        <label>
          <span className="visually-hidden">Категория</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as (typeof CATEGORIES)[number])} aria-label="Категория">
            {CATEGORIES.map((key) => (
              <option key={key} value={key}>{ru.providers.categories[key]}</option>
            ))}
          </select>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="provider-empty">{ru.providers.empty}</p>
      ) : (
        <ul className="provider-grid">
          {filtered.map((entry: ProviderCatalogEntryProjection) => {
            const status = statusByProvider.get(entry.id);
            const view = providerStatusView(status, undefined, false, false);
            return (
              <li key={entry.id}>
                <Link to={`/settings/providers/${encodeURIComponent(entry.id)}`} className="provider-card">
                  <div className="provider-card-head">
                    <strong>{entry.displayName}</strong>
                    <ProviderStatusBadge state={view.state} label={view.label} />
                  </div>
                  <div className="provider-card-meta">
                    <span className="provider-category">{ru.providers.categories[entry.category]}</span>
                    <code>{entry.id}</code>
                  </div>
                  <div className="provider-capabilities">
                    {entry.capabilities.map((cap) => (
                      <span key={cap} className="capability-chip">{ru.providers.capabilities[cap] ?? cap}</span>
                    ))}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
