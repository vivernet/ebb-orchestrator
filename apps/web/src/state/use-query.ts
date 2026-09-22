import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { queryCache } from './query-cache.js';
import type { QueryFetcher, QueryParams, QueryState } from './query-store.js';
import { canonicalQueryKey } from './query-store.js';

/** Настройки React-адаптера query cache. */
export interface UseQueryOptions {
  enabled?: boolean;
}

/** Query state плюс ручной authoritative refetch для retry-кнопок. */
export interface UseQueryResult<TData> extends QueryState<TData> {
  key: string;
  refetch: () => Promise<TData>;
}

/**
 * Подключает React consumer к app-scoped query cache.
 * Для обратной совместимости принимает store как первый аргумент (игнорируется).
 *
 * Hook не хранит копию domain state и не создаёт optimistic data. При unmount
 * consumer только отписывается: shared request может использоваться другими
 * consumers, поэтому cancellation принадлежит explicit refetch/invalidate.
 */
export function useQuery<TData>(
  _store: unknown,
  path: string,
  params: QueryParams | undefined,
  fetcher: QueryFetcher<TData>,
  options: UseQueryOptions = {},
): UseQueryResult<TData> {
  const key = canonicalQueryKey(path, params);
  const fetcherRef = fetcher;
  const enabled = options.enabled ?? true;

  // Подписка всегда нужна чтобы получать обновления (включая refetch)
  const subscription = useCallback(
    (onStoreChange: () => void): (() => void) => {
      return queryCache.subscribe(key, onStoreChange);
    },
    [key],
  );

  const state = useSyncExternalStore(
    subscription,
    () => queryCache.get<TData>(key),
    () => queryCache.get<TData>(key),
  );

  useEffect(() => {
    if (!enabled) return;
    const request = queryCache.fetch(path, params, fetcherRef);
    request.catch(() => undefined);
  }, [enabled, key, path, params, fetcherRef]);

  const refetch = useCallback(() => queryCache.refetch(path, params, fetcherRef), [key, path, params, fetcherRef]);
  return { ...state, key, refetch };
}
