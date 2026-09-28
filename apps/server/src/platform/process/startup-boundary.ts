/** Зависимости границы запуска между настройкой локального пользователя и HTTP-сервером. */
export interface StartupBoundaryDeps {
  /** Проверяет или создаёт локального пользователя; отказ прекращает запуск до workers и listener. */
  ensureLocalUser(): Promise<unknown>;
  /** Запускает lifecycle и workers только после успешной настройки пользователя. */
  startSystem(): Promise<void>;
  /** Открывает HTTP listener только после успешного lifecycle. */
  listen(): Promise<unknown>;
  /** Отменяет дальнейший startup, если сигнал поступил до READY. */
  signal?: AbortSignal;
  /** Освобождает уже приобретённые ресурсы при отказе или pre-READY сигнале. */
  cleanupStartup?: () => Promise<void>;
  /** Фиксирует READY атомарно с завершением startup boundary. */
  onReady?(): void;
}

export interface StartupCleanupDeps {
  database: { close(): void };
  instanceLock: { release(): Promise<void> };
  server?: { isListening(): boolean; close(): Promise<void> };
  workers?: readonly { stop(): Promise<void> }[];
}

/**
 * Создаёт одноразовое закрытие startup ресурсов.
 *
 * HTTP listener закрывается первым, затем закрываются database и singleton
 * lock. Повторные вызовы ждут тот же результат, а ошибка одного шага не
 * пропускает очистку остальных ресурсов.
 */
export function createStartupCleanup(deps: StartupCleanupDeps): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;

  return () => {
    cleanupPromise ??= (async () => {
      const errors: unknown[] = [];
      if (deps.server?.isListening()) {
        try {
          await deps.server.close();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const worker of deps.workers ?? []) {
        try {
          await worker.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        deps.database.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await deps.instanceLock.release();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Startup resource cleanup failed");
      }
    })();
    return cleanupPromise;
  };
}

/**
 * Направляет lifecycle signal в отмену startup или штатный shutdown.
 *
 * До READY сигнал только помечает startup как отменённый: завершившаяся фаза
 * затем отдаёт управление границе, которая освобождает ресурсы. После READY
 * сигнал передаётся штатному shutdown handler. Функция не устанавливает
 * process listeners, поэтому переход можно проверять без реального сигнала.
 */
export function createStartupSignalHandler(deps: {
  controller: AbortController;
  isReady(): boolean;
  onReadySignal(signal: string): void;
}): (signal: string) => void {
  return (signal) => {
    if (deps.isReady()) {
      deps.onReadySignal(signal);
      return;
    }
    if (!deps.controller.signal.aborted) {
      deps.controller.abort(new Error(`Startup interrupted by ${signal}`));
    }
  };
}

/**
 * Последовательно выполняет security-critical startup boundary.
 *
 * Отказ wizard намеренно пробрасывается без вызова workers или HTTP listener;
 * это сохраняет fail-closed семантику первого запуска.
 */
export async function runStartupBoundary(deps: StartupBoundaryDeps): Promise<void> {
  const assertNotAborted = () => {
    if (deps.signal?.aborted) {
      throw deps.signal.reason ?? new Error("Startup interrupted before READY");
    }
  };

  try {
    assertNotAborted();
    await deps.ensureLocalUser();
    assertNotAborted();
    await deps.startSystem();
    assertNotAborted();
    await deps.listen();
    assertNotAborted();
    deps.onReady?.();
  } catch (startupError) {
    try {
      await deps.cleanupStartup?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Startup failed and resource cleanup was incomplete",
        { cause: cleanupError },
      );
    }
    throw startupError;
  }
}
