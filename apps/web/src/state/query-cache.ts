/**
 * App-scoped query cache для всего приложения.
 * Взамен пер-сторов в каждом компоненте.
 */

import type { QueryFetcher, QueryParams, QueryState } from './query-store.js';
import { canonicalQueryKey } from './query-store.js';

/** Настройки query cache. */
export interface QueryCacheOptions {
  now?: () => number;
}

/**
 * Создаёт app-scoped query cache с shared lifecycle.
 * Все компоненты используют одну instance cache.
 */
export function createQueryCache(options: QueryCacheOptions = {}) {
  const now = options.now ?? Date.now;

  const idleState: QueryState<unknown> = { status: 'idle', data: undefined, error: null, updatedAt: null, isStale: false };

  const states = new Map<string, QueryState<unknown>>();
  const listeners = new Map<string, Set<() => void>>();
  const inFlight = new Map<string, AbortController>();

  function stateFor(key: string): QueryState<unknown> {
    return states.get(key) ?? idleState;
  }

  function publish(key: string, next: QueryState<unknown>): void {
    states.set(key, next);
    for (const listener of listeners.get(key) ?? []) listener();
  }

  function update(key: string, changes: Partial<QueryState<unknown>>): void {
    publish(key, { ...stateFor(key), ...changes });
  }

  function abortInFlight(key: string): void {
    const controller = inFlight.get(key);
    if (!controller) return;
    controller.abort();
    inFlight.delete(key);
  }

  return {
    get<T>(key: string): QueryState<T> {
      return stateFor(key) as QueryState<T>;
    },

    subscribe(key: string, listener: () => void): () => void {
      const keyListeners = listeners.get(key) ?? new Set<() => void>();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },

    fetch<T>(
      path: string,
      params: QueryParams | undefined,
      fetcher: QueryFetcher<T>,
    ): Promise<T> {
      const key = canonicalQueryKey(path, params);
      const state = stateFor(key);

      // Если есть активный запрос — ждём его
      const existingController = inFlight.get(key);
      if (existingController) {
        return new Promise<T>((resolve, reject) => {
          const check = () => {
            if (!existingController.signal.aborted) {
              // Ждём ещё
              setTimeout(check, 10);
            } else {
              // Запрос завершился, берём из cache
              const newState = stateFor(key);
              if (newState.status === 'success') resolve(newState.data as T);
              else if (newState.status === 'error') reject(newState.error);
              else reject(new Error('Query aborted'));
            }
          };
          check();
        });
      }

      // Если есть свежий успех — возвращаем
      if (state.status === 'success' && !state.isStale) {
        return Promise.resolve(state.data as T);
      }

      const controller = new AbortController();
      inFlight.set(key, controller);

      update(key, { status: 'loading', error: null, isStale: state.status === 'success' });

      return fetcher(controller.signal)
        .then((data) => {
          if (inFlight.get(key) === controller) {
            inFlight.delete(key);
            publish(key, { status: 'success', data, error: null, updatedAt: now(), isStale: false });
          }
          return data;
        })
        .catch((error) => {
          if (inFlight.get(key) === controller) {
            inFlight.delete(key);
            if (error instanceof Error && error.name === 'AbortError') {
              update(key, { status: 'idle', error: null, isStale: true });
            } else {
              update(key, { status: 'error', error, isStale: true });
            }
          }
          throw error;
        });
    },

    invalidate(path: string, params?: QueryParams): void {
      const key = canonicalQueryKey(path, params);
      abortInFlight(key);
      const state = stateFor(key);
      update(key, { status: state.status === 'success' ? 'success' : 'idle', isStale: true, error: null });
    },

    refetch<T>(
      path: string,
      params: QueryParams | undefined,
      fetcher: QueryFetcher<T>,
    ): Promise<T> {
      const key = canonicalQueryKey(path, params);
      abortInFlight(key);
      update(key, { status: 'loading', error: null, isStale: false });
      return fetcher(new AbortController().signal)
        .then((data) => {
          publish(key, { status: 'success', data, error: null, updatedAt: now(), isStale: false });
          return data;
        })
        .catch((error) => {
          update(key, { status: 'error', error, isStale: true });
          throw error;
        });
    },

    clear(): void {
      for (const [key] of inFlight) {
        inFlight.get(key)?.abort();
      }
      inFlight.clear();
      states.clear();
      listeners.clear();
    },
  };
}

/**
 * App-scoped query cache instance.
 * Должен быть создан один раз в App.tsx и передан через контекст.
 */
export const queryCache = createQueryCache();
