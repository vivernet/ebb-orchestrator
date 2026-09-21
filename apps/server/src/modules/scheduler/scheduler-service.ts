/** Supported config schema versions (contiguous range). */
const SUPPORTED_SCHEME_VERSIONS = new Set([1]);
const DEFAULT_SCHEME_VERSION = 1;
const ALL_ROLES = [
  "coordinator", "product-manager", "product_manager",
  "architect", "developer", "middle-developer", "middle_developer",
  "senior-developer", "senior_developer", "reviewer", "qa",
  "qa-agent", "qa_agent", "integration", "devops",
] as const;

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import type {
  SchedulableTask,
  Eligibility,
  WaitReason,
  BlockReason,
  Priority,
  Category,
  RecalculateResult,
  ReservationReleaseResult,
  SchedulerReconciliationResult,
  SchedulerLimits,
} from "./scheduler-types.js";
import { compareTasks } from "./scheduler-policy.js";
import { ResourceLockService } from "./resource-lock-service.js";

interface TaskRow {
  id: string;
  project_id: string;
  epic_id: string | null;
  status: string;
  contract_json: string;
  created_at: string;
}

/**\n * Сервис планировщика — координирует планирование задач и оценку элигибельности.\n *\n * Использует единственный production-экземпляр, разделяемый всеми runtime-компонентами.\n * Единый долговечный authority для элигибельности/резервирований применяется ко ВСЕМ ролям\n * с точным контролем capacity для каждой роли.\n */
/**
 *
 */
export class SchedulerService {
  /** Приватный сервис блокировок для управления ресурсами. */
  private readonly lockService: ResourceLockService;

  /** Диапазон поддерживаемых версий схемы конфигурации планировщика. */
  static readonly SUPPORTED_SCHEME_VERSIONS = SUPPORTED_SCHEME_VERSIONS;
  static readonly DEFAULT_SCHEME_VERSION = DEFAULT_SCHEME_VERSION;
  static readonly ALL_ROLES = ALL_ROLES;

  constructor(private readonly db: Database) {
    this.lockService = new ResourceLockService(db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_budgets (
      project_id TEXT PRIMARY KEY, limit_cost REAL NOT NULL, spent_cost REAL NOT NULL DEFAULT 0,
      reserved_cost REAL NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_usage_history (
      project_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'developer', model TEXT NOT NULL DEFAULT 'default',
      cost REAL NOT NULL, recorded_at TEXT NOT NULL
    )`);
    // One physical reservation/lock authority for both tasks and agent runs.
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_reservations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL, owner_id TEXT NOT NULL, reserved_at TEXT NOT NULL,
      estimate_cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'RESERVED',
      actual_cost REAL, role TEXT NOT NULL, model TEXT NOT NULL, approval_id TEXT,
      run_id TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_resource_locks (
      resource_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL,
      project_id TEXT NOT NULL, owner_id TEXT NOT NULL, locked_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_config (id INTEGER PRIMARY KEY CHECK (id=1), schema_version INTEGER NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // Initialize with defaults only if no config exists yet.
    const existing = this.db.get<{ id: string }>("SELECT id FROM scheduler_config WHERE id=1");
    if (!existing) {
      this.db.run("INSERT INTO scheduler_config(id,schema_version,config_json,updated_at) VALUES(1,$v,$config,$at)", {
        v: DEFAULT_SCHEME_VERSION,
        config: JSON.stringify({ globalMax: 4, projectMax: 3, roleCapacity: Object.fromEntries(ALL_ROLES.map((r) => [r, 4])) }),
        at: new Date().toISOString(),
      });
    }
    // Migrate legacy system_state limits into the versioned config.
    const legacy = this.db.get<{ value_json: string }>("SELECT value_json FROM system_state WHERE key IN ('scheduler_limits','scheduler.limits') ORDER BY CASE key WHEN 'scheduler_limits' THEN 0 ELSE 1 END LIMIT 1");
    if (legacy) {
      try {
        const value = JSON.parse(legacy.value_json) as { globalMax?: unknown; projectMax?: unknown; reviewerMax?: unknown };
        const current = this.db.get<{ config_json: string; schema_version: number }>("SELECT config_json,schema_version FROM scheduler_config WHERE id=1");
        const parsed = current ? JSON.parse(current.config_json) : { globalMax: 4, projectMax: 3, roleCapacity: Object.fromEntries(ALL_ROLES.map((r) => [r, 4])) };
        this.db.run("UPDATE scheduler_config SET config_json=$config,updated_at=$at WHERE id=1", {
          config: JSON.stringify({ ...parsed, globalMax: value.globalMax ?? parsed.globalMax, projectMax: value.projectMax ?? parsed.projectMax, roleCapacity: { ...(parsed.roleCapacity ?? {}), reviewer: value.reviewerMax ?? 4, developer: value.globalMax ?? 4 } }),
          at: new Date().toISOString(),
        });
      } catch { /* fail closed: malformed legacy value is rejected by getLimits */ }
    }
  }

  /**\n   * Возвращает сервис блокировок ресурсов для внешнего использования.\n   */
  get resourceLockService(): ResourceLockService {
    return this.lockService;
  }

  /**\n   * Пересчитывает элигибельность для всех активных задач (опционально в пределах проекта).\n   *\n   * Результаты детерминированы — одно и то же состояние всегда даёт одинаковый порядок.\n   */
  recalculate(scope?: { projectId: string }): RecalculateResult {
    // Получает all tasks (filtered by scope if provided)
    const tasks = this.getSchedulableTasks(scope);

    // Получает already-running tasks for capacity checking
    const alreadyRunning = tasks.filter(
      (t) => !isTerminalStatus(t.status) && t.status !== "READY" && t.status !== "DRAFT"
    );
    // Eligibility projection and dispatch use the same durable reservation
    // authority.  In particular, non-task phases consume these slots too.
    const reservedGlobal = this.reservedCount();

    // Получает ALL non-terminal tasks for dependency checking
    const allActiveTasks = (scope ? this.getSchedulableTasks() : tasks).filter((t) => !isTerminalStatus(t.status));

    // Evaluate eligibility for each task
    const runnables: SchedulableTask[] = [];
    const waiting: { task: SchedulableTask; reason: WaitReason }[] = [];
    const blocked: { task: SchedulableTask; reason: BlockReason }[] = [];

    for (const task of tasks) {
      const eligibility = this.evaluateEligibility(task, allActiveTasks);

      switch (eligibility.status) {
        case "RUNNABLE":
          runnables.push(task);
          break;
        case "WAIT":
          waiting.push({ task, reason: eligibility.reason });
          break;
        case "BLOCK":
          blocked.push({ task, reason: eligibility.reason });
          break;
      }
    }

    // Role capacity is evaluated from the same durable reservations used by
    // dispatch, so a reviewer task cannot appear runnable while its role slot
    // is already occupied.
    const limits = this.getLimits();
    const reservedReviewers = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' AND lower(role)='reviewer'",
    )?.count ?? 0;
    if (reservedReviewers >= limits.reviewerMax) {
      const roleLimited = runnables.filter((task) => task.category === "reviewer");
      const roleLimitedIds = new Set(roleLimited.map((task) => task.id));
      runnables.splice(0, runnables.length, ...runnables.filter((task) => !roleLimitedIds.has(task.id)));
      waiting.push(...roleLimited.map((task) => ({ task, reason: "WAITING_FOR_ROLE_CAPACITY" as const })));
    }

    // Sort runnables deterministically
    runnables.sort((a, b) => compareTasks(a, b));

    // Limit runnables based on capacity constraints
    // First, limit by project max
    const runnablesByProject = new Map<string, SchedulableTask[]>();
    for (const task of runnables) {
      if (!runnablesByProject.has(task.projectId)) {
        runnablesByProject.set(task.projectId, []);
      }
      runnablesByProject.get(task.projectId)!.push(task);
    }

    // Подсчитывает already running tasks per project
    const runningByProject = new Map<string, number>();
    for (const task of alreadyRunning) {
      runningByProject.set(task.projectId, (runningByProject.get(task.projectId) ?? 0) + 1);
    }
    for (const row of this.db.all<{ project_id: string; count: number }>("SELECT project_id,COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' GROUP BY project_id")) {
      runningByProject.set(row.project_id, Math.max(runningByProject.get(row.project_id) ?? 0, row.count));
    }

    // Limit each project's runnables
    const limitedByProject: SchedulableTask[] = [];
    const capacityWaiting: { task: SchedulableTask; reason: WaitReason }[] = [];
    for (const [projectId, tasks] of runnablesByProject) {
      const running = runningByProject.get(projectId) ?? 0;
      const available = Math.max(0, this.getLimits(projectId).projectMax - running);
      limitedByProject.push(...tasks.slice(0, available));
      capacityWaiting.push(...tasks.slice(available).map((task) => ({ task, reason: "WAITING_FOR_CAPACITY" as const })));
    }

    // Then limit globally
    const globalAvailable = Math.max(0, limits.globalMax - reservedGlobal);
    const globallyLimited = limitedByProject.splice(globalAvailable);
    capacityWaiting.push(...globallyLimited.map((task) => ({ task, reason: "WAITING_FOR_CAPACITY" as const })));
    runnables.length = 0;
    runnables.push(...limitedByProject);
    waiting.push(...capacityWaiting);

    // Sort waiting and blocked by priority (most important first)
    waiting.sort((a, b) =>
      comparePriority(a.task.priority, b.task.priority)
    );
    blocked.sort((a, b) =>
      comparePriority(a.task.priority, b.task.priority)
    );

    return {
      runnables,
      waiting,
      blocked,
      currentRunningCount: reservedGlobal,
    };
  }

  /** Проверяет, что сохранённая версия схемы находится в поддерживаемом диапазоне. */
  private validateSchemaVersion(schemaVersion: number): void {
    if (!SchedulerService.SUPPORTED_SCHEME_VERSIONS.has(schemaVersion)) {
      throw new Error(`unsupported scheduler configuration schema version: ${schemaVersion}`);
    }
  }

  /** Считывает и валидирует сохранённую конфигурацию планировщика. При любой проблеме — fail-closed. */
  private getPersistedConfig(): { schema_version: number; config_json: string } {
    const row = this.db.get<{ schema_version: number; config_json: string }>("SELECT schema_version,config_json FROM scheduler_config WHERE id=1");
    if (!row) throw new Error("missing persisted scheduler configuration");
    this.validateSchemaVersion(row.schema_version);
    return row;
  }

  /** Парсит и валидирует JSON конфигурации, при любой проблеме — fail-closed. */
  private parseConfig(config_json: string): { globalMax: number; projectMax: number; roleCapacity: Record<string, number> } {
    let raw: { globalMax?: unknown; projectMax?: unknown; roleCapacity?: Record<string, unknown>; projects?: Record<string, { projectMax?: unknown }> };
    try { raw = JSON.parse(config_json) as typeof raw; } catch { throw new Error("malformed persisted scheduler configuration"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("malformed persisted scheduler configuration");
    const knownFields = new Set(["globalMax", "projectMax", "roleCapacity", "projects"]);
    const unknownFields = Object.keys(raw).filter((k) => !knownFields.has(k));
    if (unknownFields.length > 0) throw new Error(`unknown scheduler configuration fields: ${unknownFields.join(", ")}`);
    if (typeof raw.globalMax !== "number" || !Number.isInteger(raw.globalMax) || raw.globalMax < 1 || raw.globalMax > 1000) throw new Error("invalid globalMax in scheduler configuration");
    if (typeof raw.projectMax !== "number" || !Number.isInteger(raw.projectMax) || raw.projectMax < 1 || raw.projectMax > 1000) throw new Error("invalid projectMax in scheduler configuration");
    if (!raw.roleCapacity || typeof raw.roleCapacity !== "object" || Array.isArray(raw.roleCapacity)) throw new Error("invalid roleCapacity in scheduler configuration");
    const roleCapacity: Record<string, number> = {};
    for (const [role, capacity] of Object.entries(raw.roleCapacity)) {
      if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error(`invalid capacity for role ${role}`);
      roleCapacity[role] = capacity;
    }
    for (const role of ALL_ROLES) {
      if (roleCapacity[role] === undefined) roleCapacity[role] = 4;
    }
    return { globalMax: raw.globalMax, projectMax: raw.projectMax, roleCapacity };
  }

  /** Считывает долговечную конфигурацию планировщика. При любой проблеме — fail-closed. */
  getLimits(_projectId?: string): SchedulerLimits {
    const persisted = this.getPersistedConfig();
    const value = this.parseConfig(persisted.config_json);
    const legacy = this.db.get<{ value_json: string }>("SELECT value_json FROM system_state WHERE key IN ('scheduler_limits','scheduler.limits') ORDER BY CASE key WHEN 'scheduler_limits' THEN 0 ELSE 1 END LIMIT 1");
    if (legacy) {
      try {
        const old = JSON.parse(legacy.value_json) as { globalMax?: unknown; projectMax?: unknown; reviewerMax?: unknown };
        if (typeof old.globalMax === "number") value.globalMax = old.globalMax;
        if (typeof old.projectMax === "number") value.projectMax = old.projectMax;
        if (old.reviewerMax !== undefined && typeof old.reviewerMax === "number") value.roleCapacity.reviewer = old.reviewerMax;
        if (old.globalMax !== undefined && typeof old.globalMax === "number") value.roleCapacity.developer = old.globalMax;
      } catch { throw new Error("malformed persisted scheduler configuration"); }
    }
    const positive = (candidate: number, name: string): number => {
      if (candidate < 1 || candidate > 1000) throw new Error(`invalid scheduler limit: ${name}`);
      return candidate;
    };
    return {
      globalMax: positive(value.globalMax, "globalMax"),
      projectMax: positive(value.projectMax, "projectMax"),
      reviewerMax: value.roleCapacity.reviewer ?? 4,
    };
  }

  getRoleCapacity(role: string): number {
    const persisted = this.getPersistedConfig();
    const value = this.parseConfig(persisted.config_json);
    const candidate = value.roleCapacity[role.toLowerCase()];
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate < 1 || candidate > 1000) throw new Error(`invalid scheduler role capacity: ${role}`);
    return candidate;
  }

  getConfig(): { schemaVersion: number; globalMax: number; projectMax: number; roleCapacity: Record<string, number> } {
    const persisted = this.getPersistedConfig();
    const value = this.parseConfig(persisted.config_json);
    return { schemaVersion: persisted.schema_version, globalMax: value.globalMax, projectMax: value.projectMax, roleCapacity: value.roleCapacity };
  }

  updateConfig(input: unknown): { schemaVersion: number; globalMax: number; projectMax: number; roleCapacity: Record<string, number> } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("scheduler configuration must be an object");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["schemaVersion", "globalMax", "projectMax", "roleCapacity"].includes(key))) throw new Error("unknown scheduler configuration field");
    const schemaVersion = typeof value.schemaVersion === "number" ? value.schemaVersion : DEFAULT_SCHEME_VERSION;
    if (!SchedulerService.SUPPORTED_SCHEME_VERSIONS.has(schemaVersion)) throw new Error(`unsupported scheduler configuration schema version: ${schemaVersion}`);
    if (typeof value.globalMax !== "number" || typeof value.projectMax !== "number" || !value.roleCapacity || typeof value.roleCapacity !== "object" || Array.isArray(value.roleCapacity)) throw new Error("invalid scheduler configuration schema");
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 1000;
    if (!valid(value.globalMax) || !valid(value.projectMax)) throw new Error("scheduler limits must be integers from 1 to 1000");
    const capacities = value.roleCapacity as Record<string, unknown>;
    if (Object.keys(capacities).length === 0 || Object.entries(capacities).some(([role, n]) => !role || !valid(n))) throw new Error("role capacities must be integers from 1 to 1000");
    const unknownRoles = Object.keys(capacities).filter((role) => !ALL_ROLES.includes(role as unknown as typeof ALL_ROLES[number]));
    if (unknownRoles.length > 0) throw new Error(`unknown roles in roleCapacity: ${unknownRoles.join(", ")}`);
    const roleCapacity: Record<string, number> = {};
    for (const [role, cap] of Object.entries(capacities)) {
      roleCapacity[role] = cap as number;
    }
    for (const role of ALL_ROLES) {
      if (roleCapacity[role] === undefined) roleCapacity[role] = 4;
    }
    this.db.run("UPDATE scheduler_config SET schema_version=$v,config_json=$config,updated_at=$at WHERE id=1", { v: schemaVersion, config: JSON.stringify({ globalMax: value.globalMax, projectMax: value.projectMax, roleCapacity }), at: new Date().toISOString() });
    return this.getConfig();
  }

  /**\n   * Считывает все планируемые задачи, опционально в пределах проекта.\n   */
  private getSchedulableTasks(
    scope?: { projectId: string },
  ): SchedulableTask[] {
    const rows = this.db.all<TaskRow>(
      scope
        ? "SELECT id, project_id, epic_id, status, contract_json, created_at FROM tasks WHERE project_id = $project_id"
        : "SELECT id, project_id, epic_id, status, contract_json, created_at FROM tasks",
      scope ? { project_id: scope.projectId } : {},
    );

    return rows.map((row) => this.toSchedulableTask(row, this.db));
  }

  /**\n   * Возвращает элигибельность для отдельной задачи.\n   */
getEligibility(taskId: string, scope?: { projectId: string }): Eligibility {
     const result = this.recalculate(scope);
     const runnable = result.runnables.some((task) => task.id === taskId);
     if (runnable) return { status: "RUNNABLE" };
     const waiting = result.waiting.find((entry) => entry.task.id === taskId);
     if (waiting) return { status: "WAIT", reason: waiting.reason };
     const blocked = result.blocked.find((entry) => entry.task.id === taskId);
     return blocked ? { status: "BLOCK", reason: blocked.reason } : { status: "BLOCK", reason: "BLOCKED_BY_WORKFLOW" };
   }

   /** Возвращает причину ожидания для задачи или null, если задача не ожидает. */
   getWaitReason(taskId: string): string | null {
     const result = this.recalculate();
     const waiting = result.waiting.find((entry) => entry.task.id === taskId);
     return waiting ? waiting.reason : null;
   }

   /**\n    * Возвращает текущее использование capacity.\n    */
  getCapacityUsage(projectId?: string): {
    running: number;
    globalMax: number;
    projectMax: number;
    available: number;
  } {
    const query = projectId
      ? "SELECT COUNT(*) as count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' AND project_id = $project_id"
      : "SELECT COUNT(*) as count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'";

    const result = this.db.get<{ count: number }>(query,
      projectId ? { project_id: projectId } : {});
    const running = result?.count ?? 0;

    return {
      running,
      globalMax: this.getLimits().globalMax,
      projectMax: projectId ? this.getLimits(projectId).projectMax : this.getLimits().globalMax,
      available: this.getLimits().globalMax - running,
    };
  }

  /**\n   * Запускает workflow runs для элигибельных задач.\n   * Возвращает список запущенных задач.\n   */
  startWorkflowRuns(
    workflowEngine: WorkflowEngine,
    onWorkflowRunStarted: (taskId: string, triggerReason: string) => void,
  ): { startedTaskIds: string[]; skipped: { taskId: string; reason: string }[] } {
    const recalculateResult = this.recalculate();
    const startedTaskIds: string[] = [];
    const skipped: { taskId: string; reason: string }[] = [];

    for (const task of recalculateResult.runnables) {
      try {
        // Проверяет task is in READY state
        const dbTask = this.db.get<{ status: string }>(
          "SELECT status FROM tasks WHERE id = $id",
          { id: task.id },
        );

        if (!dbTask || dbTask.status !== "READY") {
          skipped.push({
            taskId: task.id,
            reason: `Not in READY state. Current: ${dbTask?.status}`,
          });
          continue;
        }

        // Все callers, including the legacy bulk entry point, use the same
        // atomic authority.  There must not be a capacity-only fast path.
        this.dispatchTask(task.id, workflowEngine, onWorkflowRunStarted, "task-assignment");
        startedTaskIds.push(task.id);
      } catch (error) {
        skipped.push({
          taskId: task.id,
          reason: (error as Error).message,
        });
      }
    }

    return { startedTaskIds, skipped };
  }

  /** Авторитетный dispatch отдельной задачи, используемый при долговечном восстановлении workflow. */
  dispatchTask(
    taskId: string,
    workflowEngine: WorkflowEngine,
    onWorkflowRunStarted: (taskId: string, triggerReason: string) => void,
    triggerReasonOrOptions: string | { triggerReason?: string; approvalId?: string; role?: string; model?: string; runId?: string } = "epic-child",
   ): void {
    const options = typeof triggerReasonOrOptions === "string" ? { triggerReason: triggerReasonOrOptions } : triggerReasonOrOptions;
    const triggerReason = options.triggerReason ?? "epic-child";
    const task = this.db.get<{ project_id: string; status: string; contract_json: string }>(
      "SELECT project_id, status, contract_json FROM tasks WHERE id = $id", { id: taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "READY") throw new Error(`Task ${taskId} is not READY`);
    this.db.transaction((tx) => {
       const rows = tx.all<TaskRow>("SELECT id,project_id,epic_id,status,contract_json,created_at FROM tasks");
       const candidates = rows.map((row) => this.toSchedulableTask(row, tx));
       const candidate = candidates.find((entry) => entry.id === taskId);
       const eligibility = candidate ? this.evaluateDispatchEligibilityTx(tx, candidate, candidates.filter((entry) => !isTerminalStatus(entry.status))) : { status: "BLOCK", reason: "BLOCKED_BY_WORKFLOW" } as const;
       if (eligibility.status !== "RUNNABLE") {
        throw new Error(`Task ${taskId} is not schedulable: ${eligibility.reason}`);
      }
       const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'");
       const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$projectId AND status='RESERVED' AND kind <> 'LOCK'", { projectId: task.project_id });
       const limits = this.getLimits(task.project_id);
       if ((global?.count ?? 0) >= limits.globalMax || (project?.count ?? 0) >= limits.projectMax) {
        throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_CAPACITY`);
      }
      const category = (JSON.parse(task.contract_json) as { category?: string }).category;
      const role = options.role ?? (category === "reviewer" ? "reviewer" : "developer");
      const roleCount = tx.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' AND lower(role)=$role",
        { role },
      )?.count ?? 0;
       if (roleCount >= this.getRoleCapacity(role)) {
        throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_ROLE_CAPACITY`);
      }
      const existing = tx.get<{ id: string; run_id: string | null; status: string }>("SELECT id,run_id,status FROM scheduler_reservations WHERE subject_id=$taskId", { taskId });
      if (!existing || existing.status === "RELEASED") {
         const estimate = this.estimateCostTx(tx, task.project_id, role, "default");
        const budget = tx.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId: task.project_id });
        if (budget && budget.spent_cost + budget.reserved_cost + estimate > budget.limit_cost) throw new Error("Task " + taskId + " is not schedulable: WAITING_FOR_BUDGET");
        if (budget) tx.run("UPDATE scheduler_budgets SET reserved_cost=reserved_cost+$estimate WHERE project_id=$projectId", { projectId: task.project_id, estimate });
        if (options.approvalId) {
          const approval = tx.get<{ type: string; subject_id: string; status: string }>("SELECT type,subject_id,status FROM approvals WHERE id=$approvalId", { approvalId: options.approvalId });
          if (!approval || approval.type !== "FINAL_MERGE" || approval.subject_id !== taskId || approval.status !== "APPROVED") throw new Error(`Invalid dispatch approval for task ${taskId}`);
        }
        // Этот lock is acquired in this same transaction.  Calling the lock
        // service here would create a second transaction and permit races.
        const reservationId = existing?.id ?? crypto.randomUUID();
        const resourceKey = `task:${taskId}`;
        const externalLock = tx.get<{ owner_id: string }>("SELECT owner_id FROM scheduler_resource_locks WHERE resource_key='global'");
        if (externalLock && externalLock.owner_id !== `task:${taskId}`) throw new Error("Task " + taskId + " is not schedulable: WAITING_FOR_RESOURCE_LOCK");
        const conflictingLock = tx.get<{ reservation_id: string }>("SELECT reservation_id FROM scheduler_resource_locks WHERE resource_key=$resourceKey", { resourceKey });
        if (conflictingLock) throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_RESOURCE_LOCK`);
        if (existing) {
          tx.run("UPDATE scheduler_reservations SET project_id=$projectId,owner_id=$ownerId,reserved_at=$at,estimate_cost=$estimate,status='RESERVED',actual_cost=NULL,role=$role,model='default',approval_id=$approvalId,run_id=$runId WHERE id=$id AND status='RELEASED'", { id: reservationId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString(), estimate, role, approvalId: options.approvalId ?? null, runId: options.runId ?? null });
        } else {
          tx.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,approval_id,run_id) VALUES($id,'TASK',$taskId,$projectId,$ownerId,$at,$estimate,'RESERVED',$role,'default',$approvalId,$runId)", { id: reservationId, taskId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString(), estimate, role, approvalId: options.approvalId ?? null, runId: options.runId ?? null });
        }
        tx.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES($resourceKey,$reservationId,$projectId,$ownerId,$at)", { resourceKey, reservationId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString() });
      } else if (options.runId !== undefined && existing.run_id !== options.runId) {
        throw new Error(`Task ${taskId} reservation run identity mismatch: expected ${options.runId}, found ${existing.run_id ?? "NULL"}`);
      }
      workflowEngine.transitionInTransaction(tx, taskId, "DEVELOPMENT");
    });
    onWorkflowRunStarted(taskId, triggerReason);
  }

  /** Резервирует non-task AI phase через тот же authority для budget/capacity. */
  dispatchAgentRun(runId: string, projectId: string, role: string, model: string, resourceKey = `run:${runId}`, options: { approvalId?: string } = {}): void {
    this.db.transaction((tx) => {
      const existing = tx.get<{ status: string; run_id: string | null }>("SELECT status,run_id FROM scheduler_reservations WHERE subject_id=$runId", { runId });
      if (existing?.status === "RESERVED") {
        if (existing.run_id !== runId) {
          throw new Error(`Run ${runId} reservation run identity mismatch: expected ${runId}, found ${existing.run_id ?? "NULL"}`);
        }
        return;
      }
       const projectState = tx.get<{ status: string }>("SELECT status FROM projects WHERE id=$projectId", { projectId });
       if (projectState && projectState.status !== "ACTIVE") throw new Error(`Run ${runId} is not schedulable: BLOCKED_BY_PROJECT_STATE`);
       const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'")?.count ?? 0;
       const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$projectId AND status='RESERVED' AND kind <> 'LOCK'", { projectId })?.count ?? 0;
       const limits = this.getLimits(projectId);
       if (global >= limits.globalMax || project >= limits.projectMax) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_CAPACITY`);
       if (tx.get("SELECT resource_key FROM scheduler_resource_locks WHERE resource_key IN ('global',$resourceKey)", { resourceKey })) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_RESOURCE_LOCK`);
       const roleCount = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' AND lower(role)=lower($role)", { role })?.count ?? 0;
       if (roleCount >= this.getRoleCapacity(role)) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_ROLE_CAPACITY`);
       if (options.approvalId) {
         const approval = tx.get<{ status: string; subject_id: string }>("SELECT status,subject_id FROM approvals WHERE id=$approvalId", { approvalId: options.approvalId });
         if (!approval || approval.status !== "APPROVED" || ![runId, projectId].includes(approval.subject_id)) throw new Error(`Invalid dispatch approval for run ${runId}`);
       }
       const estimate = this.estimateCost(projectId, role, model);
      const budget = tx.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId });
      if (budget && budget.spent_cost + budget.reserved_cost + estimate > budget.limit_cost) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_BUDGET`);
      if (budget) tx.run("UPDATE scheduler_budgets SET reserved_cost=reserved_cost+$estimate WHERE project_id=$projectId", { projectId, estimate });
      const now = new Date().toISOString();
      tx.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES($id,'PHASE',$runId,$projectId,$ownerId,$at,$estimate,'RESERVED',$role,$model,$runId)", { id: crypto.randomUUID(), runId, projectId, ownerId: `run:${runId}`, at: now, estimate, role, model });
      const reservation = tx.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id=$runId", { runId })!;
      tx.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES($resourceKey,$reservationId,$projectId,$ownerId,$at)", { resourceKey, reservationId: reservation.id, projectId, ownerId: `run:${runId}`, at: now });
    });
  }

  /** Сводит phase reservation с конкретным AgentRun. */
  releaseAgentRun(runId: string, actualCost: number): ReservationReleaseResult {
    return this.db.transaction((tx) => {
      const reservation = tx.get<{ id: string; project_id: string; estimate_cost: number; role: string; model: string; owner_id: string }>("SELECT id,project_id,estimate_cost,role,model,owner_id FROM scheduler_reservations WHERE status='RESERVED' AND run_id=$runId LIMIT 1", { runId });
      if (!reservation) return { status: "ALREADY_RELEASED" };
      if (!this.lockOwnerMatches(tx, reservation)) return { status: "BLOCKED_OWNERSHIP_DRIFT", reservationId: reservation.id };
      const actual = Math.max(0, actualCost);
      tx.run("UPDATE scheduler_reservations SET status='RELEASED',actual_cost=$actual WHERE id=$id AND status='RESERVED'", { id: reservation.id, actual });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return { status: "ALREADY_RELEASED" };
      tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate),spent_cost=spent_cost+$actual WHERE project_id=$projectId", { projectId: reservation.project_id, estimate: reservation.estimate_cost, actual });
      if (actual > 0) tx.run("INSERT INTO scheduler_usage_history(project_id,role,model,cost,recorded_at) VALUES($projectId,$role,$model,$actual,$at)", { projectId: reservation.project_id, role: reservation.role, model: reservation.model, actual, at: new Date().toISOString() });
      tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id });
      return { status: "RELEASED", reservationId: reservation.id };
    });
  }

  /** Освобождает резервацию только после того, как сохранённый run достигнет terminal state. */
  releaseTask(taskId: string, actualCost = 0): ReservationReleaseResult {
    return this.db.transaction((tx) => {
      const reservation = tx.get<{ id: string; project_id: string; estimate_cost: number; owner_id: string }>("SELECT id,project_id,estimate_cost,owner_id FROM scheduler_reservations WHERE subject_id=$taskId AND status='RESERVED'", { taskId });
      if (!reservation) return { status: "ALREADY_RELEASED" };
      if (!this.lockOwnerMatches(tx, reservation)) return { status: "BLOCKED_OWNERSHIP_DRIFT", reservationId: reservation.id };
      const actual = Math.max(0, actualCost);
      const budget = tx.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId: reservation.project_id });
      tx.run("UPDATE scheduler_reservations SET status='RELEASED',actual_cost=$actual WHERE id=$id AND status='RESERVED'", { id: reservation.id, actual });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return { status: "ALREADY_RELEASED" };
      if (budget) tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate), spent_cost=spent_cost+$actual WHERE project_id=$projectId", { projectId: reservation.project_id, estimate: reservation.estimate_cost, actual });
      if (actual > 0) tx.run("INSERT INTO scheduler_usage_history(project_id,role,model,cost,recorded_at) VALUES($projectId,'developer','default',$actual,$at)", { projectId: reservation.project_id, actual, at: new Date().toISOString() });
      tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id });
      return { status: "RELEASED", reservationId: reservation.id };
    });
  }

  /** Сводит резервации и блокировки после краша или прерванного run. */
  reconcile(): SchedulerReconciliationResult {
    if (!this.db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'")) return { releasedReservationIds: [], blockedReservationIds: [] };
    return this.db.transaction((tx) => {
      const result: SchedulerReconciliationResult = { releasedReservationIds: [], blockedReservationIds: [] };
      const rows = tx.all<{ id: string; subject_id: string; project_id: string; estimate_cost: number; kind: string; owner_id: string; run_id: string | null }>("SELECT id,subject_id,project_id,estimate_cost,kind,owner_id,run_id FROM scheduler_reservations WHERE status='RESERVED' ORDER BY id");
      for (const row of rows) {
        if (!this.lockOwnerMatches(tx, row)) {
          result.blockedReservationIds.push(row.id);
          continue;
        }
        // LOCK reservations are owned by the task/resource lock authority,
        // not by an AgentRun with a task-shaped subject id.  In particular,
        // an active task must keep its lock across a restart.
        if (row.kind === "LOCK") {
          if (!row.subject_id.startsWith("lock:")) continue;
          const task = tx.get<{ status: string }>("SELECT status FROM tasks WHERE id=$taskId", { taskId: row.subject_id.slice("lock:".length) });
          if (!task || !isTerminalStatus(task.status)) continue;
          tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate) WHERE project_id=$projectId", { projectId: row.project_id, estimate: row.estimate_cost });
          tx.run("UPDATE scheduler_reservations SET status='RELEASED',actual_cost=0 WHERE id=$id AND status='RESERVED'", { id: row.id });
          tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: row.id });
          result.releasedReservationIds.push(row.id);
          continue;
        }
        if (row.run_id === null) {
          result.blockedReservationIds.push(row.id);
          continue;
        }
        const run = tx.get<{ status: string; cost: number | null }>(
          "SELECT status,cost FROM agent_runs WHERE id=$runId",
          { runId: row.run_id },
        );
        if (!run) {
          result.blockedReservationIds.push(row.id);
          continue;
        }
        if (["FAILED", "CANCELLED", "COMPLETED"].includes(run.status)) {
          const actual = run.cost ?? 0;
          tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate),spent_cost=spent_cost+$actual WHERE project_id=$projectId", { projectId: row.project_id, estimate: row.estimate_cost, actual });
          tx.run("UPDATE scheduler_reservations SET status='RELEASED',actual_cost=$actual WHERE id=$id AND status='RESERVED'", { id: row.id, actual });
          tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: row.id });
          result.releasedReservationIds.push(row.id);
        }
      }
      return result;
    });
  }

  private lockOwnerMatches(tx: DatabaseTx, reservation: { id: string; owner_id: string }): boolean {
    return !tx.get(
      "SELECT 1 FROM scheduler_resource_locks WHERE reservation_id=$id AND owner_id<>$owner LIMIT 1",
      { id: reservation.id, owner: reservation.owner_id },
    );
  }

  private estimateCost(projectId: string, role: string, model: string): number {
    const values = this.db.all<{ cost: number }>("SELECT cost FROM scheduler_usage_history WHERE project_id=$projectId AND role=$role AND model=$model ORDER BY cost", { projectId, role, model });
    if (!values.length) return 1;
    const index = Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1);
    return Math.max(0, values[index]!.cost * 1.25);
  }

  private estimateCostTx(tx: DatabaseTx, projectId: string, role: string, model: string): number {
    const values = tx.all<{ cost: number }>("SELECT cost FROM scheduler_usage_history WHERE project_id=$projectId AND role=$role AND model=$model ORDER BY cost", { projectId, role, model });
    if (!values.length) return 1;
    const index = Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1);
    return Math.max(0, values[index]!.cost * 1.25);
  }

  private reservedCount(projectId?: string, role?: string): number {
    const clauses = ["status='RESERVED'", "kind <> 'LOCK'"];
    const params: Record<string, string> = {};
    if (projectId) { clauses.push("project_id=$projectId"); params.projectId = projectId; }
    if (role) { clauses.push("lower(role)=lower($role)"); params.role = role; }
    return this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM scheduler_reservations WHERE ${clauses.join(" AND ")}`, params)?.count ?? 0;
  }

  /** Единственная реализация элигибельности. Считывает долговечное состояние, никогда не подсказывает. */
  private evaluateEligibility(task: SchedulableTask, activeTasks: SchedulableTask[]): Eligibility {
    return this.evaluateEligibilityTx(this.db, task, activeTasks);
  }

  private evaluateEligibilityTx(tx: DatabaseTx, task: SchedulableTask, activeTasks: SchedulableTask[]): Eligibility {
    const projectState = tx.get<{ status: string }>("SELECT status FROM projects WHERE id=$projectId", { projectId: task.projectId });
    if (projectState && projectState.status !== "ACTIVE") return { status: "BLOCK", reason: "BLOCKED_BY_PROJECT_STATE" };
    if (isTerminalStatus(task.status) || task.status === "DRAFT" || task.status === "PAUSED") return { status: "BLOCK", reason: task.status === "DRAFT" ? "BLOCKED_BY_PROJECT_STATE" : "BLOCKED_BY_WORKFLOW" };
    if (task.status !== "READY") {
      if (task.status === "WAITING_FOR_DEPENDENCY") return { status: "WAIT", reason: "WAITING_FOR_DEPENDENCY" };
      if (task.status === "WAITING_FOR_APPROVAL") return { status: "WAIT", reason: "WAITING_FOR_APPROVAL" };
      if (task.status === "WAITING_FOR_RESOURCE_LOCK") return { status: "WAIT", reason: "WAITING_FOR_RESOURCE_LOCK" };
      if (task.status === "WAITING_FOR_BUDGET") return { status: "WAIT", reason: "WAITING_FOR_BUDGET" };
      if (task.status === "WAITING_FOR_CAPACITY") return { status: "WAIT", reason: "WAITING_FOR_CAPACITY" };
      if (task.status === "WAITING_FOR_ROLE_CAPACITY") return { status: "WAIT", reason: "WAITING_FOR_ROLE_CAPACITY" };
      return { status: "BLOCK", reason: "BLOCKED_BY_WORKFLOW" };
    }
    const dependency = task.dependsOnTaskIds.some((id) => {
      const candidate = activeTasks.find((entry) => entry.id === id);
      return candidate !== undefined && !isTerminalStatus(candidate.status);
    });
    if (dependency) return { status: "WAIT", reason: "WAITING_FOR_DEPENDENCY" };

    const owner = `task:${task.id}`;
    if (tx.get("SELECT 1 FROM scheduler_resource_locks WHERE owner_id<>$owner AND resource_key IN ('global',$resource)", { owner, resource: `task:${task.id}` })) return { status: "WAIT", reason: "WAITING_FOR_RESOURCE_LOCK" };
    if (this.hasPendingApprovalTx(tx, task.id)) return { status: "WAIT", reason: "WAITING_FOR_APPROVAL" };

    const role = task.category === "reviewer" ? "reviewer" : "developer";
    const limits = this.getLimits(task.projectId);
    const global = this.countTx(tx, "status='RESERVED' AND kind <> 'LOCK'");
    const projectCount = this.countTx(tx, "status='RESERVED' AND kind <> 'LOCK' AND project_id=$projectId", { projectId: task.projectId });
    if (global >= limits.globalMax || projectCount >= limits.projectMax) return { status: "WAIT", reason: "WAITING_FOR_CAPACITY" };
     if (this.countTx(tx, "status='RESERVED' AND kind <> 'LOCK' AND lower(role)=lower($role)", { role }) >= this.getRoleCapacity(role)) return { status: "WAIT", reason: "WAITING_FOR_ROLE_CAPACITY" };

    const budget = tx.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId: task.projectId });
    if (budget && budget.spent_cost + budget.reserved_cost + this.estimateCostTx(tx, task.projectId, role, "default") > budget.limit_cost) return { status: "WAIT", reason: "WAITING_FOR_BUDGET" };
    return { status: "RUNNABLE" };
  }

  private evaluateDispatchEligibilityTx(tx: DatabaseTx, task: SchedulableTask, activeTasks: SchedulableTask[]): Eligibility {
    const base = this.evaluateEligibilityTx(tx, task, activeTasks);
    if (base.status !== "RUNNABLE") return base;
    const limits = this.getLimits(task.projectId);
    let global = this.countTx(tx, "status='RESERVED' AND kind <> 'LOCK'");
    const projectCounts = new Map<string, number>();
    for (const row of tx.all<{ project_id: string; count: number }>("SELECT project_id,COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' GROUP BY project_id")) projectCounts.set(row.project_id, row.count);
    // Отслеживает reservations per role for ALL roles, not just reviewer.
    const roleCounts = new Map<string, number>();
    for (const row of tx.all<{ role: string; count: number }>("SELECT lower(role) AS role,COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' GROUP BY lower(role)")) {
      roleCounts.set(row.role, row.count);
    }
    const candidates = activeTasks.filter((entry) => this.evaluateEligibilityTx(tx, entry, activeTasks).status === "RUNNABLE").sort(compareTasks);
    for (const candidate of candidates) {
      const role = candidate.category === "reviewer" ? "reviewer" : "developer";
      if (global >= limits.globalMax || (projectCounts.get(candidate.projectId) ?? 0) >= this.getLimits(candidate.projectId).projectMax) continue;
      if ((roleCounts.get(role) ?? 0) >= this.getRoleCapacity(role)) continue;
      global++;
      projectCounts.set(candidate.projectId, (projectCounts.get(candidate.projectId) ?? 0) + 1);
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      if (candidate.id === task.id) return { status: "RUNNABLE" };
    }
    // Проверяет if the task's specific role is at capacity.
    const taskRole = task.category === "reviewer" ? "reviewer" : "developer";
    if ((roleCounts.get(taskRole) ?? 0) >= this.getRoleCapacity(taskRole)) {
      return { status: "WAIT", reason: "WAITING_FOR_ROLE_CAPACITY" };
    }
    return { status: "WAIT", reason: "WAITING_FOR_CAPACITY" };
  }

  private countTx(tx: DatabaseTx, predicate: string, params: Record<string, string> = {}): number {
    return tx.get<{ count: number }>(`SELECT COUNT(*) AS count FROM scheduler_reservations WHERE ${predicate}`, params)?.count ?? 0;
  }

  private hasPendingApprovalTx(tx: DatabaseTx, taskId: string): boolean {
    return Boolean(tx.get("SELECT id FROM approvals WHERE subject_id=$taskId AND status='PENDING'", { taskId }));
  }

  private toSchedulableTask(row: TaskRow, source: DatabaseTx): SchedulableTask {
    const contract = JSON.parse(row.contract_json) as { dependencies?: string[]; priority?: Priority; category?: Category };
    return { id: row.id, projectId: row.project_id, epicId: row.epic_id, status: row.status, priority: contract.priority ?? "Normal", category: contract.category ?? "new-development", createdAt: row.created_at, dependsOnTaskIds: contract.dependencies ?? [], hasResourceLock: Boolean(source.get("SELECT 1 FROM scheduler_resource_locks WHERE owner_id=$owner", { owner: `task:${row.id}` })), hasBudgetPlaceholder: false, hasPendingApproval: this.hasPendingApprovalTx(source, row.id) };
  }

}

/** Периодическая безопасная рекоилиляция для единственного production планировщика. */
export class SchedulerSafetyWorker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly scheduler: Pick<SchedulerService, "reconcile">, private readonly intervalMs = 5_000) {}

  start(): void {
    this.timer = setInterval(() => {
      try { this.scheduler.reconcile(); } catch { /* next tick retries; state remains durable */ }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**\n * Проверяет, является ли статус терминальным.\n */
function isTerminalStatus(status: string): boolean {
  return status === "DONE" || status === "CANCELLED" || status === "FAILED" ||
    status === "INTEGRATED_INTO_EPIC" || status === "RELEASED";
}

/**
 * Проверяет if task needs budget placeholder.
 */
/**\n * Сравнивает приоритеты — возвращает отрицательное число, если a имеет более высокий приоритет.\n */
function comparePriority(a: Priority, b: Priority): number {
  const order: Record<Priority, number> = {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  };
  return order[a] - order[b];
}
