/**
 * Scheduler service - coordinates task scheduling and eligibility evaluation.
 */

import type { Database } from "../../platform/database/database.js";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import type {
  SchedulableTask,
  Eligibility,
  WaitReason,
  BlockReason,
  Priority,
  Category,
  RecalculateResult,
} from "./scheduler-types.js";
import { CAPACITY } from "./scheduler-types.js";
import { determineEligibility, compareTasks } from "./scheduler-policy.js";
import { ResourceLockService } from "./resource-lock-service.js";

interface TaskRow {
  id: string;
  project_id: string;
  epic_id: string | null;
  status: string;
  contract_json: string;
  created_at: string;
}

/**
 * Scheduler service that evaluates task eligibility for execution.
 */
export class SchedulerService {
  private readonly lockService: ResourceLockService;
  private readonly lockTimestampColumn: "locked_at" | "acquired_at";

  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS resource_locks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, locked_at TEXT NOT NULL, owner_id TEXT NOT NULL
    )`);
    this.lockService = new ResourceLockService(db);
    const lockColumns = this.db.all<{ name: string }>("PRAGMA table_info(resource_locks)");
    this.lockTimestampColumn = lockColumns.some((column) => column.name === "locked_at") ? "locked_at" : "acquired_at";
    // Keep older test/embedded databases usable while migrations are applied.
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, reserved_at TEXT NOT NULL,
      estimate_cost REAL NOT NULL DEFAULT 0, run_id TEXT, status TEXT NOT NULL DEFAULT 'RESERVED', actual_cost REAL
      , approval_id TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_budgets (
      project_id TEXT PRIMARY KEY, limit_cost REAL NOT NULL, spent_cost REAL NOT NULL DEFAULT 0,
      reserved_cost REAL NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_usage_history (
      project_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'developer', model TEXT NOT NULL DEFAULT 'default',
      cost REAL NOT NULL, recorded_at TEXT NOT NULL
    )`);
    for (const column of ["estimate_cost REAL NOT NULL DEFAULT 0", "run_id TEXT", "status TEXT NOT NULL DEFAULT 'RESERVED'", "actual_cost REAL", "approval_id TEXT"]) {
      try { this.db.exec(`ALTER TABLE scheduler_capacity_reservations ADD COLUMN ${column}`); } catch { /* current schema */ }
    }
  }

  /**
   * Get the resource lock service for external use.
   */
  get resourceLockService(): ResourceLockService {
    return this.lockService;
  }

  /**
   * Recalculate eligibility for all active tasks (optionally scoped to a project).
   *
   * Results are deterministic - same state always produces same ordering.
   */
  recalculate(scope?: { projectId: string }): RecalculateResult {
    // Get all tasks (filtered by scope if provided)
    const tasks = this.getSchedulableTasks(scope);

    // Get already-running tasks for capacity checking
    const alreadyRunning = tasks.filter(
      (t) => !isTerminalStatus(t.status) && t.status !== "READY" && t.status !== "DRAFT"
    );

    // Get ALL non-terminal tasks for dependency checking
    const allActiveTasks = tasks.filter((t) => !isTerminalStatus(t.status));

    // Evaluate eligibility for each task
    const runnables: SchedulableTask[] = [];
    const waiting: { task: SchedulableTask; reason: WaitReason }[] = [];
    const blocked: { task: SchedulableTask; reason: BlockReason }[] = [];

    for (const task of tasks) {
      const eligibility = determineEligibility(task, allActiveTasks);

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

    // Count already running tasks per project
    const runningByProject = new Map<string, number>();
    for (const task of alreadyRunning) {
      runningByProject.set(task.projectId, (runningByProject.get(task.projectId) ?? 0) + 1);
    }

    // Limit each project's runnables
    const limitedByProject: SchedulableTask[] = [];
    for (const [projectId, tasks] of runnablesByProject) {
      const running = runningByProject.get(projectId) ?? 0;
      const available = Math.max(0, CAPACITY.projectMax - running);
      limitedByProject.push(...tasks.slice(0, available));
    }

    // Then limit globally
    const globalAvailable = Math.max(0, CAPACITY.globalMax - alreadyRunning.length);
    limitedByProject.splice(globalAvailable);
    runnables.length = 0;
    runnables.push(...limitedByProject);

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
      currentRunningCount: alreadyRunning.length,
    };
  }

  /**
   * Get all schedulable tasks, optionally scoped to a project.
   */
  private getSchedulableTasks(
    scope?: { projectId: string },
  ): SchedulableTask[] {
    const rows = this.db.all<TaskRow>(
      scope
        ? "SELECT id, project_id, epic_id, status, contract_json, created_at FROM tasks WHERE project_id = $project_id"
        : "SELECT id, project_id, epic_id, status, contract_json, created_at FROM tasks",
      scope ? { project_id: scope.projectId } : {},
    );

    return rows.map((row) => {
      const contract = JSON.parse(row.contract_json) as {
        dependencies?: string[];
        required?: boolean;
        priority?: Priority;
        category?: Category;
      };

      return {
        id: row.id,
        projectId: row.project_id,
        epicId: row.epic_id,
        status: row.status,
        priority: contract.priority ?? "Normal",
        category: contract.category ?? "new-development",
        createdAt: row.created_at,
        dependsOnTaskIds: contract.dependencies ?? [],
        hasResourceLock: this.lockService.isLocked(row.id),
        // The policy field is true only when a persisted budget account exists
        // but cannot reserve the next run; absence of an account means the
        // project has no budget gate configured.
        hasBudgetPlaceholder: this.budgetUnavailable(row.project_id),
        hasPendingApproval: this.hasPendingApproval(row.id),
      };
    });
  }

  /**
   * Get eligibility for a single task.
   */
  getEligibility(taskId: string, scope?: { projectId: string }): Eligibility {
    const tasks = this.getSchedulableTasks(scope);
    const task = tasks.find((t) => t.id === taskId);

    if (!task) {
      return { status: "BLOCK", reason: "BLOCKED_BY_WORKFLOW" };
    }

    const allActiveTasks = tasks.filter((t) => !isTerminalStatus(t.status));
    return determineEligibility(task, allActiveTasks);
  }

  /**
   * Get current capacity usage.
   */
  getCapacityUsage(projectId?: string): {
    running: number;
    globalMax: number;
    projectMax: number;
    available: number;
  } {
    const query = projectId
      ? "SELECT COUNT(*) as count FROM tasks WHERE status NOT IN ('DONE', 'CANCELLED', 'FAILED') AND project_id = $project_id"
      : "SELECT COUNT(*) as count FROM tasks WHERE status NOT IN ('DONE', 'CANCELLED', 'FAILED')";

    const result = this.db.get<{ count: number }>(query,
      projectId ? { project_id: projectId } : {});
    const running = result?.count ?? 0;

    return {
      running,
      globalMax: CAPACITY.globalMax,
      projectMax: projectId ? CAPACITY.projectMax : CAPACITY.globalMax,
      available: CAPACITY.globalMax - running,
    };
  }

  /**
   * Start workflow runs for eligible tasks.
   * Returns the list of tasks that were started.
   */
  startWorkflowRuns(
    workflowEngine: WorkflowEngine,
    onWorkflowRunStarted: (taskId: string, triggerReason: string) => void,
  ): { startedTaskIds: string[]; skipped: { taskId: string; reason: string }[] } {
    const recalculateResult = this.recalculate();
    const startedTaskIds: string[] = [];
    const skipped: { taskId: string; reason: string }[] = [];

    for (const task of recalculateResult.runnables) {
      try {
        // Validate task is in READY state
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

        // All callers, including the legacy bulk entry point, use the same
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

  /** Authoritative single-task dispatch used by durable workflow recovery. */
  dispatchTask(
    taskId: string,
    workflowEngine: WorkflowEngine,
    onWorkflowRunStarted: (taskId: string, triggerReason: string) => void,
    triggerReasonOrOptions: string | { triggerReason?: string; approvalId?: string; role?: string; model?: string } = "epic-child",
  ): void {
    const options = typeof triggerReasonOrOptions === "string" ? { triggerReason: triggerReasonOrOptions } : triggerReasonOrOptions;
    const triggerReason = options.triggerReason ?? "epic-child";
    const task = this.db.get<{ project_id: string; status: string }>(
      "SELECT project_id, status FROM tasks WHERE id = $id", { id: taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "READY") throw new Error(`Task ${taskId} is not READY`);
    this.db.transaction((tx) => {
      const eligibility = this.getEligibility(taskId, { projectId: task.project_id });
      if (eligibility.status !== "RUNNABLE") {
        throw new Error(`Task ${taskId} is not schedulable: ${eligibility.reason}`);
      }
      const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_capacity_reservations WHERE status='RESERVED'");
      const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_capacity_reservations WHERE project_id=$projectId AND status='RESERVED'", { projectId: task.project_id });
      if ((global?.count ?? 0) >= CAPACITY.globalMax || (project?.count ?? 0) >= CAPACITY.projectMax) {
        throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_CAPACITY`);
      }
      const existing = tx.get("SELECT task_id FROM scheduler_capacity_reservations WHERE task_id=$taskId AND status='RESERVED'", { taskId });
      if (!existing) {
        const estimate = this.estimateCost(task.project_id, "developer", "default");
        const budget = tx.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId: task.project_id });
        if (budget && budget.spent_cost + budget.reserved_cost + estimate > budget.limit_cost) throw new Error("Task " + taskId + " is not schedulable: WAITING_FOR_BUDGET");
        if (budget) tx.run("UPDATE scheduler_budgets SET reserved_cost=reserved_cost+$estimate WHERE project_id=$projectId", { projectId: task.project_id, estimate });
        if (options.approvalId) {
          const approval = tx.get<{ type: string; subject_id: string; status: string }>("SELECT type,subject_id,status FROM approvals WHERE id=$approvalId", { approvalId: options.approvalId });
          if (!approval || approval.type !== "FINAL_MERGE" || approval.subject_id !== taskId || approval.status !== "APPROVED") throw new Error(`Invalid dispatch approval for task ${taskId}`);
        }
        // The lock is acquired in this same transaction.  Calling the lock
        // service here would create a second transaction and permit races.
        const externalLock = tx.get<{ task_id: string }>("SELECT task_id FROM resource_locks WHERE id='global'");
        if (externalLock && externalLock.task_id !== taskId) throw new Error("Task " + taskId + " is not schedulable: WAITING_FOR_RESOURCE_LOCK");
        const ownLock = tx.get("SELECT id FROM resource_locks WHERE task_id=$taskId", { taskId });
        if (!ownLock) tx.run(`INSERT INTO resource_locks(id,task_id,owner_id,${this.lockTimestampColumn}) VALUES($lockId,$taskId,$ownerId,$at)`, { lockId: `dispatch:${taskId}`, taskId, ownerId: `task:${taskId}`, at: new Date().toISOString() });
        tx.run("INSERT INTO scheduler_capacity_reservations(task_id,project_id,owner_id,reserved_at,estimate_cost,status,approval_id) VALUES($taskId,$projectId,$ownerId,$at,$estimate,'RESERVED',$approvalId)", { taskId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString(), estimate, approvalId: options.approvalId ?? null });
      }
      workflowEngine.transitionInTransaction(tx, taskId, "DEVELOPMENT");
    });
    onWorkflowRunStarted(taskId, triggerReason);
  }

  /** Release a reservation only after the persisted run has reached a terminal state. */
  releaseTask(taskId: string, actualCost = 0): void {
    this.db.transaction((tx) => {
      const reservation = tx.get<{ project_id: string; estimate_cost: number; status: string }>("SELECT project_id,estimate_cost,status FROM scheduler_capacity_reservations WHERE task_id=$taskId", { taskId });
      if (!reservation) { tx.run("DELETE FROM resource_locks WHERE task_id=$taskId", { taskId }); return; }
      const actual = Math.max(0, actualCost);
      const budget = tx.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId: reservation.project_id });
      if (budget) tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate), spent_cost=spent_cost+$actual WHERE project_id=$projectId", { projectId: reservation.project_id, estimate: reservation.estimate_cost, actual });
      if (actual > 0) tx.run("INSERT INTO scheduler_usage_history(project_id,role,model,cost,recorded_at) VALUES($projectId,'developer','default',$actual,$at)", { projectId: reservation.project_id, actual, at: new Date().toISOString() });
      tx.run("DELETE FROM scheduler_capacity_reservations WHERE task_id=$taskId", { taskId });
      tx.run("DELETE FROM resource_locks WHERE task_id=$taskId", { taskId });
    });
  }

  /** Reconcile reservations and locks after a crash or interrupted run. */
  reconcile(): void {
    if (!this.db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'")) return;
    this.db.transaction((tx) => {
      const rows = tx.all<{ task_id: string; project_id: string; estimate_cost: number }>("SELECT task_id,project_id,estimate_cost FROM scheduler_capacity_reservations WHERE status='RESERVED'");
      for (const row of rows) {
        const run = tx.get<{ status: string; cost: number | null }>("SELECT status,cost FROM agent_runs WHERE task_id=$taskId ORDER BY started_at DESC LIMIT 1", { taskId: row.task_id });
        if (!run || ["FAILED", "CANCELLED", "COMPLETED"].includes(run.status)) {
          const actual = run?.cost ?? 0;
          tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate),spent_cost=spent_cost+$actual WHERE project_id=$projectId", { projectId: row.project_id, estimate: row.estimate_cost, actual });
          tx.run("DELETE FROM scheduler_capacity_reservations WHERE task_id=$taskId", { taskId: row.task_id });
          tx.run("DELETE FROM resource_locks WHERE task_id=$taskId", { taskId: row.task_id });
        }
      }
      tx.run("DELETE FROM resource_locks WHERE task_id NOT IN (SELECT id FROM tasks WHERE status NOT IN ('DONE','FAILED','CANCELLED','RELEASED'))");
    });
  }

  private estimateCost(projectId: string, role: string, model: string): number {
    const values = this.db.all<{ cost: number }>("SELECT cost FROM scheduler_usage_history WHERE project_id=$projectId AND role=$role AND model=$model ORDER BY cost", { projectId, role, model });
    if (!values.length) return 1;
    const index = Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1);
    return Math.max(0, values[index]!.cost * 1.25);
  }

  private budgetUnavailable(projectId: string): boolean {
    const budget = this.db.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId });
    return Boolean(budget && budget.spent_cost + budget.reserved_cost >= budget.limit_cost);
  }

  private hasPendingApproval(taskId: string): boolean {
    return Boolean(this.db.get("SELECT id FROM approvals WHERE subject_id=$taskId AND status='PENDING'", { taskId }));
  }
}

/**
 * Check if status is terminal.
 */
function isTerminalStatus(status: string): boolean {
  return status === "DONE" || status === "CANCELLED" || status === "FAILED" ||
    status === "INTEGRATED_INTO_EPIC" || status === "RELEASED";
}

/**
 * Check if task needs budget placeholder.
 */
/**
 * Compare priorities - returns negative if a is higher priority.
 */
function comparePriority(a: Priority, b: Priority): number {
  const order: Record<Priority, number> = {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  };
  return order[a] - order[b];
}
