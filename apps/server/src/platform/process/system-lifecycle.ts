/**
 * System lifecycle – orchestrates the startup sequence and exposes
 * the runtime status state machine.
 *
 * States: STARTING → RECOVERING → READY → (PAUSED | DEGRADED) → SHUTTING_DOWN
 *
 * The startup order is explicit in {@link startSystem}:
 * 1. Acquire single-instance lock
 * 2. Open database
 * 3. Run migrations
 * 4. Set status to RECOVERING
 * 5. Reconcile outbox / jobs / artifacts / additional reconcilers
 * 6. Set status to READY
 * 7. Start workers
 */

export type SystemStatus =
  | "STARTING"
  | "RECOVERING"
  | "READY"
  | "PAUSED"
  | "DEGRADED"
  | "SHUTTING_DOWN";

/** Handle returned by `InstanceLock.acquire()`. */
export interface LockHandle {
  pid: number;
}

/** Subset of the Database interface required by the lifecycle. */
export interface LifecycleDatabase {
  open(): Promise<void>;
  close(): void;
}

/** Migrator interface for running schema migrations. */
export interface LifecycleMigrator {
  run(): Promise<void>;
}

/** Status tracker that holds the current system status. */
export interface StatusTrackerInterface {
  get(): SystemStatus;
  set(status: SystemStatus): Promise<void>;
}

/** Simple worker interface for background processing. */
export interface BackgroundWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * All dependencies needed to bring the system online.
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

/**
 * Run the startup sequence with the given dependencies.
 *
 * The order is intentional and must not be reordered.
 */
export async function startSystem(deps: SystemLifecycleDeps): Promise<void> {
  if (!deps.lockAlreadyAcquired) await deps.instanceLock.acquire();
  await deps.database.open();
  await deps.migrator.run();
  await deps.status.set("RECOVERING");
  await deps.reconcileOutbox();
  await deps.reconcileJobs();
  await deps.reconcileArtifacts();
  for (const reconcile of deps.additionalReconcilers) {
    await reconcile();
  }
  await deps.status.set("READY");
  for (const worker of deps.workers) {
    await worker.start();
  }
}

/**
 * In-memory status tracker.
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
 * Graceful shutdown orchestration.
 *
 * Steps:
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

  // Stop workers – prevents new work from starting.
  for (const worker of deps.workers) {
    await worker.stop();
  }

  // Give in-flight operations a grace period.
  await new Promise((resolve) => setTimeout(resolve, timeout));

  deps.database.close();
  await deps.instanceLock.release();
}
