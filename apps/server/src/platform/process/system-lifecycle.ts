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
 * 5. Preflight process owners and reconcile Project Config
 * 6. Reconcile outbox / jobs / artifacts / additional reconcilers
 * 7. Start workers
 * 8. Set status to READY
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

/** Доверенные имена recovery-фаз, единственные допустимые значения для startup-логов. */
export const RECOVERY_PHASE_NAMES = [
  "preflight_recovery",
  "reconcile_project_config",
  "reconcile_outbox",
  "reconcile_jobs",
  "reconcile_artifacts",
  "production_startup_reconciliation",
  "reconcile_epic_runs",
  "reconcile_scheduler",
  "cleanup_terminal_hermes_profiles",
  "reconcile_planning_requests",
  "reconcile_execution_claims",
  "resume_approved_epics",
  "invalid_recovery_step",
] as const;

export type RecoveryPhaseName = (typeof RECOVERY_PHASE_NAMES)[number];
const recoveryPhaseNameSet: ReadonlySet<string> = new Set(RECOVERY_PHASE_NAMES);

/** Именованный дополнительный шаг recovery, выполняемый до запуска workers. */
export interface NamedRecoveryStep {
  /** Стабильный идентификатор фазы для безопасной startup-диагностики. */
  name: RecoveryPhaseName;
  /** Выполняет одну фазу восстановления. */
  run(): Promise<void>;
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
  /** Доказывает/останавливает каждый nonterminal process scope до любого recovery side effect. */
  preflightRecovery(): Promise<void>;
  /** Integrity reconciliation допускается только после process-owner STOPPED proof. */
  reconcileProjectConfig(): Promise<void>;
  reconcileOutbox(): Promise<void>;
  reconcileJobs(): Promise<void>;
  reconcileArtifacts(): Promise<void>;
  additionalReconcilers: NamedRecoveryStep[];
  workers: BackgroundWorker[];
  /** Прерывает startup между фазами и откатывает уже запущенные workers. */
  signal?: AbortSignal;
}

function assertStartupActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Startup interrupted before READY");
}

async function runRecoveryStep(step: RecoveryPhaseName, reconcile: () => Promise<void>): Promise<void> {
  try {
    await reconcile();
  } catch (error) {
    // Не выводим message/error object: reconciliation может содержать secrets
    // или raw repository/model output. Диагностика ограничена фиксированным шагом.
    const errorKind = error instanceof Error ? "error" : "non_error";
    const safeStep = recoveryPhaseNameSet.has(step) ? step : "invalid_recovery_step";
    console.error(`[orchestrator] startup reconciliation failed: step=${safeStep}; error_kind=${errorKind}`);
    throw error;
  }
}

/**
 * Выполняет the startup sequence with the given dependencies.
 *
 * Порядок выбран намеренно и не должен изменяться.
 */
export async function startSystem(deps: SystemLifecycleDeps): Promise<void> {
  assertStartupActive(deps.signal);
  if (!deps.lockAlreadyAcquired) await deps.instanceLock.acquire();
  assertStartupActive(deps.signal);
  await deps.database.open();
  assertStartupActive(deps.signal);
  await deps.migrator.run();
  assertStartupActive(deps.signal);
  await deps.status.set("RECOVERING");
  assertStartupActive(deps.signal);
  try {
    await runRecoveryStep("preflight_recovery", deps.preflightRecovery);
    assertStartupActive(deps.signal);
    await runRecoveryStep("reconcile_project_config", deps.reconcileProjectConfig);
    assertStartupActive(deps.signal);
    await runRecoveryStep("reconcile_outbox", deps.reconcileOutbox);
    assertStartupActive(deps.signal);
    await runRecoveryStep("reconcile_jobs", deps.reconcileJobs);
    assertStartupActive(deps.signal);
    await runRecoveryStep("reconcile_artifacts", deps.reconcileArtifacts);
    assertStartupActive(deps.signal);
    for (const reconcile of deps.additionalReconcilers) {
      await runRecoveryStep(reconcile.name, () => reconcile.run());
      assertStartupActive(deps.signal);
    }
  } catch (error) {
    if (deps.signal?.aborted) throw deps.signal.reason ?? error;
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
      assertStartupActive(deps.signal);
      await worker.start();
      startedWorkers.push(worker);
      assertStartupActive(deps.signal);
    }
    await deps.status.set("READY");
    assertStartupActive(deps.signal);
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
