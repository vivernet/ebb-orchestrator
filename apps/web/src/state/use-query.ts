import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  canonicalQueryKey,
  type QueryFetcher,
  type QueryParams,
  type QueryState,
  type QueryStore,
} from './query-store.js';

/** Настройки React-адаптера query store. */
export interface UseQueryOptions {
  enabled?: boolean;
}

/** Query state плюс ручной authoritative refetch для retry-кнопок. */
export interface UseQueryResult<TData> extends QueryState<TData> {
  key: string;
  refetch: () => Promise<TData>;
}

/**
 * Подключает React consumer к существующему query store.
 *
 * Hook не хранит копию domain state и не создаёт optimistic data. При unmount
 * consumer только отписывается: shared request может использоваться другими
 * consumers, поэтому cancellation принадлежит explicit refetch/invalidate.
 */
export function useQuery<TData>(
  store: QueryStore,
  path: string,
  params: QueryParams | undefined,
  fetcher: QueryFetcher<TData>,
  options: UseQueryOptions = {},
): UseQueryResult<TData> {
  const key = canonicalQueryKey(path, params);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const subscription = useMemo(() => {
    let last = store.get<TData>(key);
    const getSnapshot = (): QueryState<TData> => {
      const next = store.get<TData>(key);
      if (
        next.status === last.status
        && next.data === last.data
        && next.error === last.error
        && next.updatedAt === last.updatedAt
        && next.isStale === last.isStale
      ) return last;
      last = next;
      return next;
    };
    const subscribe = (onStoreChange: () => void): (() => void) => store.subscribe<TData>(key, (state) => {
      last = state;
      onStoreChange();
    });
    return { getSnapshot, subscribe };
  }, [key, store]);
  const state = useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return undefined;
    const request = store.fetch(path, params, fetcherRef.current);
    request.catch(() => undefined);
    return undefined;
  }, [enabled, key, path, store]);

  const refetch = useCallback(() => store.refetch(path, params, fetcherRef.current), [key, path, store]);
  return { ...state, key, refetch };
}
