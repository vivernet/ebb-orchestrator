/**
 * Жизненный цикл системы — координирует запуск и предоставляет
 * конечный автомат состояния runtime.
 *
 * Состояния: STARTING → RECOVERING → READY → (PAUSED | DEGRADED) → SHUTTING_DOWN
 *
 * Порядок запуска явно задан в {@link startSystem}:
 * 1. Acquire single-instance lock
 * 2. Open database
 * 3. Run migrations
 * 4. Set status to RECOVERING
 * 5. Reconcile outbox / jobs / artifacts / additional reconcilers
 * 6. Start workers
 * 7. Set status to READY
 */

export type SystemStatus =
  | "STARTING"
  | "RECOVERING"
  | "READY"
  | "PAUSED"
  | "DEGRADED"
  | "SHUTTING_DOWN";

/** Обрабатывает returned by `InstanceLock.acquire()`. */
export interface LockHandle {
  pid: number;
}

/** Подмножество of the Database interface required by the lifecycle. */
export interface LifecycleDatabase {
  open(): Promise<void>;
  close(): void;
}

/** Migrator интерфейс для running schemОбъект migrations. */
export interface LifecycleMigrator {
  run(): Promise<void>;
}

/** Состояние tracker that holds the current system status. */
export interface StatusTrackerInterface {
  get(): SystemStatus;
  set(status: SystemStatus): Promise<void>;
}

/** Простой worker interface for background processing. */
export interface BackgroundWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Все dependencies needed to bring the system online.
 */
export interface SystemLifecycleDeps {
  instanceLock: {
    acquire(): Promise<LockHandle>;
    release(): Promise<void>;
  };
  /**
   * Указывает, что entry point захватил lock до миграций. Это сохраняет
   * порядок startup без повторного acquire того же экземпляра lock.
   */
  lockAlreadyAcquired?: boolean;
  database: LifecycleDatabase;
  migrator: LifecycleMigrator;
  status: StatusTrackerInterface;
  reconcileOutbox(): Promise<void>;
  reconcileJobs(): Promise<void>;
  reconcileArtifacts(): Promise<void>;
  additionalReconcilers: Array<() => Promise<void>>;
  workers: BackgroundWorker[];
}

async function runRecoveryStep(step: string, reconcile: () => Promise<void>): Promise<void> {
  try {
    await reconcile();
  } catch (error) {
    // Не выводим message/error object: reconciliation может содержать secrets
    // или raw repository/model output. Диагностика ограничена фиксированным шагом.
    const errorKind = error instanceof Error ? "error" : "non_error";
    console.error(`[orchestrator] startup reconciliation failed: step=${step}; error_kind=${errorKind}`);
    throw error;
  }
}

/**
 * Выполняет the startup sequence with the given dependencies.
 *
 * Порядок выбран намеренно и не должен изменяться.
 */
export async function startSystem(deps: SystemLifecycleDeps): Promise<void> {
  if (!deps.lockAlreadyAcquired) await deps.instanceLock.acquire();
  await deps.database.open();
  await deps.migrator.run();
  await deps.status.set("RECOVERING");
  try {
    await runRecoveryStep("reconcile_outbox", deps.reconcileOutbox);
    await runRecoveryStep("reconcile_jobs", deps.reconcileJobs);
    await runRecoveryStep("reconcile_artifacts", deps.reconcileArtifacts);
    for (const reconcile of deps.additionalReconcilers) {
      await reconcile();
    }
  } catch {
    // HTTP server должен оставаться доступным для health/readiness диагностики,
    // но workers нельзя запускать после неполного recovery.
    await deps.status.set("DEGRADED");
    return;
  }

  // Reconciliation может явно перевести lifecycle в DEGRADED без throw.
  // В этом состоянии caller может поднять HTTP server, но система не готова.
  if (deps.status.get() === "DEGRADED") {
    return;
  }

  const startedWorkers: BackgroundWorker[] = [];
  try {
    for (const worker of deps.workers) {
      await worker.start();
      startedWorkers.push(worker);
    }
  } catch (error) {
    // Не leave partially started workers running when startup cannot
    // establish Объект fully operational system.  Этот статус должен also remain
    // non-ready so readiness probes cannot report Объект false positive.
    await Promise.allSettled(
      startedWorkers.map(async (worker) => {
        await worker.stop();
      }),
    );
    await deps.status.set("DEGRADED");
    throw error;
  }
  await deps.status.set("READY");
}

/**
 * В памяти status tracker.
 */
export class StatusTracker implements StatusTrackerInterface {
  private status: SystemStatus = "STARTING";

  get(): SystemStatus {
    return this.status;
  }

  async set(status: SystemStatus): Promise<void> {
    this.status = status;
  }
}

/**
 * Корректное shutdown orchestration.
 *
 * Шаги:
 * 1. Set status to SHUTTING_DOWN
 * 2. Stop all workers (prevent new dispatch)
 * 3. Wait up to `timeoutMs` for in-flight work to flush
 * 4. Close database
 * 5. Release single-instance lock
 */
export async function shutdownSystem(deps: {
  status: StatusTrackerInterface;
  workers: BackgroundWorker[];
  database: LifecycleDatabase;
  instanceLock: { release(): Promise<void> };
  timeoutMs?: number;
}): Promise<void> {
  const timeout = deps.timeoutMs ?? 10_000;

  await deps.status.set("SHUTTING_DOWN");

  // Останавливает workers конкурентно и enforce один grace-period deadline для the
  // всю остановку.  Объект worker который cannot останавливать in time не должен multiply the
  // задержку остановки процесса by Объект число of workers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPromise = Promise.allSettled(
    deps.workers.map(async (worker) => {
      await worker.stop();
    }),
  );
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeout);
  });
  await Promise.race([stopPromise.then(() => undefined), timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);

  deps.database.close();
  await deps.instanceLock.release();
}
