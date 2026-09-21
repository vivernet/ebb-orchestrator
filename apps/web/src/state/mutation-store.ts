/** Состояния жизненного цикла одной policy-checked mutation. */
export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

/** Наблюдаемое состояние mutation без optimistic изменения domain state. */
export interface MutationState<T> {
  status: MutationStatus;
  data: T | undefined;
  error: unknown | null;
}

/** Минимальный интерфейс project-local mutation lifecycle store. */
export interface MutationStore {
  /** Возвращает текущее состояние ключа или начальное idle-состояние. */
  get<T>(key: string): MutationState<T>;
  /** Подписывает consumer на pending/confirmed/error transitions. */
  subscribe<T>(key: string, listener: (state: MutationState<T>) => void): () => void;
  /**
   * Запускает command один раз; при наличии refetch ждёт authoritative state
   * перед success. Без refetch вызывающий код обязан использовать этот путь
   * только когда сам успешный HTTP response является достаточным подтверждением.
   */
  execute<T>(key: string, command: () => Promise<T>, refetch?: () => Promise<unknown>): Promise<T>;
}

type Listener = (state: MutationState<unknown>) => void;

/**
 * Создаёт lifecycle store для policy-checked commands.
 * Store не меняет domain state оптимистично: подтверждением считается только
 * успешная command и завершившийся authoritative refetch.
 */
export function createMutationStore(): MutationStore {
  const states = new Map<string, MutationState<unknown>>();
  const listeners = new Map<string, Set<Listener>>();
  const inFlight = new Map<string, Promise<unknown>>();

  function stateFor(key: string): MutationState<unknown> {
    return states.get(key) ?? { status: 'idle', data: undefined, error: null };
  }

  function publish(key: string, state: MutationState<unknown>): void {
    states.set(key, state);
    for (const listener of listeners.get(key) ?? []) listener(state);
  }

  return {
    get<T>(key: string): MutationState<T> {
      return stateFor(key) as MutationState<T>;
    },

    subscribe<T>(key: string, listener: (state: MutationState<T>) => void): () => void {
      const keyListeners = listeners.get(key) ?? new Set<Listener>();
      const typedListener = listener as (state: MutationState<unknown>) => void;
      keyListeners.add(typedListener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(typedListener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },

    execute<T>(key: string, command: () => Promise<T>, refetch?: () => Promise<unknown>): Promise<T> {
      const active = inFlight.get(key) as Promise<T> | undefined;
      if (active) return active;

      publish(key, { status: 'pending', data: undefined, error: null });
      const request = Promise.resolve()
        .then(command)
        .then(async (data) => {
          await refetch?.();
          publish(key, { status: 'success', data, error: null });
          return data;
        })
        .catch((error: unknown) => {
          publish(key, { status: 'error', data: undefined, error });
          throw error;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, request);
      return request;
    },
  };
}
