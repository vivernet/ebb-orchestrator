/** Параметры, входящие в канонический ключ query. */
export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Состояния жизненного цикла одного query. */
export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

/** Наблюдаемое состояние query без владения доменным состоянием. */
export interface QueryState<T> {
  status: QueryStatus;
  data: T | undefined;
  error: unknown | null;
  updatedAt: number | null;
  isStale: boolean;
}

/** Fetcher получает AbortSignal, которым store управляет при refetch/invalidate. */
export type QueryFetcher<T> = (signal: AbortSignal) => Promise<T>;

export interface QueryStore {
  /** Читает текущее состояние или возвращает начальное idle-состояние. */
  get<T>(key: string): QueryState<T>;
  /** Подписывает consumer на изменения состояния и возвращает функцию отписки. */
  subscribe<T>(key: string, listener: (state: QueryState<T>) => void): () => void;
  /** Загружает query, используя cache и dedupe для уже активного запроса. */
  fetch<T>(path: string, params: QueryParams | undefined, fetcher: QueryFetcher<T>): Promise<T>;
  /** Отменяет активный запрос и помечает сохранённое значение stale. */
  invalidate(path: string, params?: QueryParams): void;
  /** Принудительно перечитывает query и публикует только актуальный результат. */
  refetch<T>(path: string, params: QueryParams | undefined, fetcher: QueryFetcher<T>): Promise<T>;
}

interface QueryStoreOptions {
  now?: () => number;
}

type Listener = (state: QueryState<unknown>) => void;

interface InFlightRequest<T> {
  controller: AbortController;
  promise: Promise<T>;
}

/**
 * Строит стабильный ключ по endpoint path и нормализованным query-параметрам.
 * `undefined` не является параметром, а `null` сохраняется как пустое значение.
 */
export function canonicalQueryKey(path: string, params?: QueryParams): string {
  const entries = Object.entries(params ?? {})
    .filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return path;

  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value === null ? '' : String(value))}`)
    .join('&');
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Создаёт небольшой project-local query store без внешнего cache-фреймворка.
 * Store владеет только request lifecycle; authoritative domain state остаётся backend.
 */
export function createQueryStore(options: QueryStoreOptions = {}): QueryStore {
  const states = new Map<string, QueryState<unknown>>();
  const listeners = new Map<string, Set<Listener>>();
  const inFlight = new Map<string, InFlightRequest<unknown>>();
  const now = options.now ?? Date.now;

  function idleState(): QueryState<unknown> {
    return { status: 'idle', data: undefined, error: null, updatedAt: null, isStale: false };
  }

  function stateFor(key: string): QueryState<unknown> {
    return states.get(key) ?? idleState();
  }

  function publish(key: string, next: QueryState<unknown>): void {
    states.set(key, next);
    for (const listener of listeners.get(key) ?? []) listener(next);
  }

  function update(key: string, changes: Partial<QueryState<unknown>>): void {
    publish(key, { ...stateFor(key), ...changes });
  }

  function abortInFlight(key: string): void {
    const request = inFlight.get(key);
    if (!request) return;
    inFlight.delete(key);
    request.controller.abort();
  }

  function isCurrent<T>(key: string, request: InFlightRequest<T>): boolean {
    return inFlight.get(key) === request;
  }

  function abortError(): Error {
    const error = new Error('Query request aborted');
    error.name = 'AbortError';
    return error;
  }

  function startRequest<T>(key: string, fetcher: QueryFetcher<T>): Promise<T> {
    const previous = stateFor(key);
    const controller = new AbortController();
    const request = {} as InFlightRequest<T>;
    const requestPromise = new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
      const settle = () => {
        if (settled) return;
        settled = true;
        cleanup();
      };
      const onAbort = () => {
        if (settled) return;
        settle();
        reject(abortError());
      };

      controller.signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve()
        .then(() => fetcher(controller.signal))
        .then((value) => {
          if (settled) return;
          settle();
          resolve(value);
        }, (error: unknown) => {
          if (settled) return;
          settle();
          reject(error);
        });
    });

    const trackedPromise = requestPromise.then(
      (data) => {
        if (isCurrent(key, request)) {
          inFlight.delete(key);
          publish(key, { status: 'success', data, error: null, updatedAt: now(), isStale: false });
        }
        return data;
      },
      (error: unknown) => {
        if (isCurrent(key, request)) {
          inFlight.delete(key);
          if (error instanceof Error && error.name === 'AbortError') {
            update(key, { status: 'idle', error: null, isStale: true });
          } else {
            update(key, { status: 'error', error, isStale: true });
          }
        }
        throw error;
      },
    );
    request.controller = controller;
    request.promise = trackedPromise;
    inFlight.set(key, request as InFlightRequest<unknown>);
    update(key, { status: 'loading', error: null, isStale: previous.isStale || previous.status === 'success' });

    return trackedPromise;
  }

  return {
    get<T>(key: string): QueryState<T> {
      return stateFor(key) as QueryState<T>;
    },

    subscribe<T>(key: string, listener: (state: QueryState<T>) => void): () => void {
      const keyListeners = listeners.get(key) ?? new Set<Listener>();
      const typedListener = listener as (state: QueryState<unknown>) => void;
      keyListeners.add(typedListener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(typedListener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },

    fetch<T>(path: string, params: QueryParams | undefined, fetcher: QueryFetcher<T>): Promise<T> {
      const key = canonicalQueryKey(path, params);
      const state = stateFor(key);
      if (state.status === 'success' && !state.isStale) return Promise.resolve(state.data as T);
      const active = inFlight.get(key) as InFlightRequest<T> | undefined;
      return active?.promise ?? startRequest(key, fetcher);
    },

    invalidate(path: string, params?: QueryParams): void {
      const key = canonicalQueryKey(path, params);
      abortInFlight(key);
      const state = stateFor(key);
      update(key, { status: state.status === 'success' ? 'success' : 'idle', isStale: true, error: null });
    },

    refetch<T>(path: string, params: QueryParams | undefined, fetcher: QueryFetcher<T>): Promise<T> {
      const key = canonicalQueryKey(path, params);
      abortInFlight(key);
      return startRequest(key, fetcher);
    },
  };
}
