import { join } from "node:path";
import type { Database } from "../database/database.js";
import { ArtifactRepository } from "../artifacts/artifact-repository.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { HermesRuntimeAdapter } from "../../modules/runtime/hermes/hermes-runtime-adapter.js";
import { ProcessExecutor } from "../process/process-executor.js";
import { SystemdRunSupervisor } from "../process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../process/windows-job-supervisor.js";
import type { ProcessScopeSupervisor } from "../process/run-scope-supervisor.js";
import { GitCli } from "../../modules/git/git-cli.js";
import { GitReconciler } from "../../modules/git/git-reconciler.js";
import { IntegrationService } from "../../modules/git/integration-service.js";
import { MergeService, type MergeResult } from "../../modules/git/merge-service.js";
import { TaskWorkspaceProvisioner } from "../../modules/git/task-workspace-provisioner.js";
import { EpicWorkspaceProvisioner } from "../../modules/git/epic-workspace-provisioner.js";
import { WorktreeManager } from "../../modules/git/worktree-manager.js";
import type { EpicOrchestrator, IntegrationServiceFactory, IntegrationServiceFactoryContext } from "../../modules/planning/epic-orchestrator.js";
import type { PlanningService } from "../../modules/planning/planning-service.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { listActiveApprovedOnboardingRepositories } from "../../modules/projects/onboarding-service.js";
import { StartupReconciler, failClosedStartupReconciliation } from "../process/startup-reconciler.js";
import type { RunService } from "../../modules/runtime/run-service.js";
import type { EventDispatcher } from "../events/event-dispatcher.js";
import type { StatusTrackerInterface } from "../process/system-lifecycle.js";
import { createProductionPaths } from "./production-paths.js";
import type { OrchestratorHomePaths } from "./orchestrator-home.js";
import { recoverExpiredJobs } from "../jobs/job-repository.js";
import { preflightRunProcessOwners } from "../../modules/runtime/run-process-owner.js";
import type { ProjectConfigService } from "../../modules/projects/project-config-service.js";

/** Зависимости для построения production adapters без старта процессов. */
export interface ProductionCompositionOptions {
  /** Уже открытая база после успешного применения миграций. */
  database: Database;
  /** Проверенные каталоги приложения, разрешённые по конфигурации пользователя. */
  home: OrchestratorHomePaths;
  /** Зависимость для детерминированной проверки startup recovery. */
  gitReconciler?: Pick<GitReconciler, "initialize" | "reconcile">;
  /** Платформенный supervisor можно подменить только в provider-free tests. */
  processScopeSupervisor?: ProcessScopeSupervisor;
}

/** Зависимости application services, необходимые для startup recovery callbacks. */
export interface ProductionStartupReconciliationOptions {
  /** Сервис runs уже создан после применения migrations. */
  runService: Pick<RunService, "reconcileInterruptedRuns">;
  /** Dispatcher уже привязан к application EventBus. */
  eventDispatcher: Pick<EventDispatcher, "dispatchBatch">;
  /** Lifecycle status изменяется только startup coordinator. */
  status: StatusTrackerInterface;
  /** Project Config integrity проверяется после process-owner preflight. */
  projectConfigService: Pick<ProjectConfigService, "reconcileActiveOnStartup">;
}

/**
 * Создаёт application-specific recovery callbacks в порядке production startup.
 * Общий список используют и `main.ts`, и restart acceptance: это сохраняет одну
 * проверяемую последовательность после process-owner preflight и platform recovery.
 *
 * @param dependencies Production services, чьи durable state reconciles выполняются до READY.
 * @param dependencies.epicOrchestrator Epic recovery и approved-plan resume.
 * @param dependencies.scheduler Восстановление scheduler reservations.
 * @param dependencies.planningService Восстановление незавершённых Request planning jobs.
 * @returns Пять callbacks для Epic runs, scheduler, Requests, execution claims и approved Epic resume.
 */
export function createApplicationRecoveryReconcilers(dependencies: {
  /** Epic lifecycle recovery и возобновление approved plans. */
  epicOrchestrator: Pick<EpicOrchestrator, "reconcileInterruptedRuns" | "reconcileInterruptedExecutionClaims" | "resumeApprovedEpics">;
  /** Восстанавливает scheduler reservations после Run recovery. */
  scheduler: Pick<SchedulerService, "reconcile">;
  /** Восстанавливает незавершённые Request planning jobs. */
  planningService: Pick<PlanningService, "reconcileInterruptedRequests">;
}): Array<() => Promise<void>> {
  const { epicOrchestrator, scheduler, planningService } = dependencies;
  return [
    async () => { epicOrchestrator.reconcileInterruptedRuns(); },
    async () => { scheduler.reconcile(); },
    async () => { planningService.reconcileInterruptedRequests(); },
    async () => { epicOrchestrator.reconcileInterruptedExecutionClaims(); },
    () => epicOrchestrator.resumeApprovedEpics(),
  ];
}

/**
 * Создаёт production adapters, привязанные к Orchestrator home.
 * Конструктор не запускает listener или subprocess; их запуск остаётся под
 * контролем startup lifecycle. Все изменяющие файловую систему операции
 * выполняются только при последующем вызове соответствующего adapter.
 */
export function createProductionComposition(options: ProductionCompositionOptions) {
  const { database, home } = options;
  const paths = createProductionPaths(home);
  const processExecutor = new ProcessExecutor();
  const processScopeSupervisor = options.processScopeSupervisor ?? createPlatformSupervisor(processExecutor);
  const gitReconciler = options.gitReconciler ?? new GitReconciler(new GitCli(processExecutor));
  const runtime = new HermesRuntimeAdapter(processExecutor, undefined, {
    databasePath: paths.hermesDatabasePath,
    resultDirectory: paths.hermesResultDirectory,
    checkpointDirectory: paths.hermesCheckpointDirectory,
  }, processScopeSupervisor);
  const taskWorkspaceProvisioner = new TaskWorkspaceProvisioner({
    database,
    worktreeManager: new WorktreeManager({ db: database, worktreeDir: paths.taskWorktreeDirectory }),
  });
  const epicWorkspaceProvisioner = new EpicWorkspaceProvisioner({ database, worktreeDir: paths.epicWorktreeDirectory });
  const integrationServiceFactory: IntegrationServiceFactory = ({ worktreeRoot, epicId, taskId, integrationRunId, finalizeRunFailure }: IntegrationServiceFactoryContext) =>
    new IntegrationService({ database, provenanceDatabasePath: home.database, integrationRunId, finalizeRunFailure, worktreeDir: join(worktreeRoot, epicId, taskId ?? "epic-final") });
  const artifactStore = new ArtifactStore(home.artifacts, new ArtifactRepository(database));

  /**
   * Создаёт полный набор recovery callbacks после migrations. Они выполняются
   * lifecycle до старта workers и перехода в READY; Git checks остаются local-only.
   */
  const createStartupReconciliation = (recovery: ProductionStartupReconciliationOptions) => {
    const reconciler = new StartupReconciler();
    reconciler.register(async () => {
      const errors: string[] = [];
      for (const project of listActiveApprovedOnboardingRepositories(database)) {
        try {
          const proposed = JSON.parse(project.proposed_json) as { defaultBranch?: unknown };
          const branch = typeof proposed.defaultBranch === "string" && proposed.defaultBranch.length > 0
            ? proposed.defaultBranch
            : "master";
          await gitReconciler.initialize(project.repository_path);
          const result = await gitReconciler.reconcile(branch);
          if (result.state !== "IN_SYNC") console.warn(`[ebb-orchestrator] Git drift: ${result.state}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[ebb-orchestrator] Git reconciliation failed: ${message}`);
          errors.push(message);
        }
      }
      if (errors.length > 0) throw new Error(`Git reconciliation failed: ${errors.join("; ")}`);
    });
    reconciler.register(async () => {
      const interrupted = recovery.runService.reconcileInterruptedRuns();
      console.warn(`[ebb-orchestrator] Recovered interrupted runs: ${interrupted}`);
    });
    reconciler.register(async () => {
      const activeProjects = database.all<{ id: string }>("SELECT id FROM projects WHERE status='ACTIVE'");
      const budgetProjects = database.all<{ project_id: string }>("SELECT project_id FROM scheduler_budgets");
      const existing = new Set(budgetProjects.map((budget) => budget.project_id));
      for (const project of activeProjects) {
        if (!existing.has(project.id)) {
          database.run(
            "INSERT OR IGNORE INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000000,0,0)",
            { projectId: project.id },
          );
        }
      }
    });
    return {
      preflightRecovery: async () => { await preflightRunProcessOwners(database, processScopeSupervisor); },
      reconcileProjectConfig: async () => { recovery.projectConfigService.reconcileActiveOnStartup(); },
      reconcileOutbox: async () => { await recovery.eventDispatcher.dispatchBatch(100); },
      reconcileJobs: async () => {
        database.transaction((tx) => recoverExpiredJobs(tx, new Date()));
      },
      reconcileArtifacts: async () => { await artifactStore.reconcileStagingArtifacts(); },
      additionalReconcilers: [async () => {
        const report = await reconciler.run();
        if (report.errors.length) {
          console.error(`[ebb-orchestrator] reconciliation errors: ${report.errors.length}`);
          for (const error of report.errors) console.error(`  ${error.message}`);
        }
        await failClosedStartupReconciliation(report, recovery.status);
      }],
    };
  };

  return {
    paths,
    runtime,
    epicWorkspaceProvisioner,
    taskWorkspaceProvisioner,
    integrationServiceFactory,
    artifactStore,
    processExecutor,
    processScopeSupervisor,
    gitReconciler,
    createStartupReconciliation,
    epicMergeAuthority: createEpicMergeAuthority(database),
  };
}

function createPlatformSupervisor(executor: ProcessExecutor): ProcessScopeSupervisor {
  if (process.platform === "win32") return new WindowsJobSupervisor(executor);
  if (process.platform === "linux") return new SystemdRunSupervisor(executor);
  return {
    async inspect() { return { state: "UNKNOWN", reason: "UNSUPPORTED_PROCESS_SCOPE_PLATFORM" }; },
    async launch() { throw new Error("PROCESS_SCOPE_PLATFORM_UNSUPPORTED"); },
    async stop() { return { state: "UNKNOWN", reason: "UNSUPPORTED_PROCESS_SCOPE_PLATFORM" }; },
    async waitForStopped() { return { state: "UNKNOWN", reason: "UNSUPPORTED_PROCESS_SCOPE_PLATFORM" }; },
  };
}

/**
 * Возвращает только authority-bound Epic merge facade. Путь репозитория
 * извлекается из активного approved onboarding и не принимается от клиента.
 */
function createEpicMergeAuthority(database: Database): {
  mergeApproved(subjectId: string, approvalId: string): Promise<MergeResult>;
  mergeApprovedForIntegration(subjectId: string, approvalId: string, integrationRunId: string): Promise<MergeResult>;
} {
  const resolveRepository = (epicId: string): string => {
    const row = database.get<{ repository_path: string }>(
      `SELECT oc.repository_path
         FROM onboarding_configs oc
         JOIN approvals a ON a.id=oc.approval_id
         JOIN epics e ON e.project_id=oc.project_id
        WHERE e.id=$epicId AND oc.status='ACTIVE'
          AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
          AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
      { epicId },
    );
    if (!row?.repository_path) throw new Error("active onboarding repository is required");
    return row.repository_path;
  };
  return {
    async mergeApproved(subjectId, approvalId) {
      throw new Error(`Epic merge requires exact Integration provenance: ${subjectId}:${approvalId}`);
    },
    async mergeApprovedForIntegration(subjectId, approvalId, integrationRunId) {
      const service = new MergeService({ database, repoPath: resolveRepository(subjectId) });
      return service.mergeApprovedForIntegration(subjectId, approvalId, integrationRunId);
    },
  };
}
