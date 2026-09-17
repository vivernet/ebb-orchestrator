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

  constructor(private readonly db: Database) {
    this.lockService = new ResourceLockService(db);
    // Keep older test/embedded databases usable while migrations are applied.
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, reserved_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_budgets (
      project_id TEXT PRIMARY KEY, limit_cost REAL NOT NULL, spent_cost REAL NOT NULL DEFAULT 0,
      reserved_cost REAL NOT NULL DEFAULT 0
    )`);
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

        // Transition to DEVELOPMENT
        workflowEngine.transition(task.id, "DEVELOPMENT");
        startedTaskIds.push(task.id);

        // Notify the orchestrator
        onWorkflowRunStarted(task.id, "task-assignment");
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
  ): void {
    const task = this.db.get<{ project_id: string; status: string }>(
      "SELECT project_id, status FROM tasks WHERE id = $id", { id: taskId });
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "READY") throw new Error(`Task ${taskId} is not READY`);
    this.db.transaction((tx) => {
      const eligibility = this.getEligibility(taskId, { projectId: task.project_id });
      if (eligibility.status !== "RUNNABLE") {
        throw new Error(`Task ${taskId} is not schedulable: ${eligibility.reason}`);
      }
      const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_capacity_reservations");
      const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_capacity_reservations WHERE project_id=$projectId", { projectId: task.project_id });
      if ((global?.count ?? 0) >= CAPACITY.globalMax || (project?.count ?? 0) >= CAPACITY.projectMax) {
        throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_CAPACITY`);
      }
      const existing = tx.get("SELECT task_id FROM scheduler_capacity_reservations WHERE task_id=$taskId", { taskId });
      if (!existing) tx.run("INSERT INTO scheduler_capacity_reservations(task_id,project_id,owner_id,reserved_at) VALUES($taskId,$projectId,$ownerId,$at)", { taskId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString() });
      workflowEngine.transitionInTransaction(tx, taskId, "DEVELOPMENT");
    });
    onWorkflowRunStarted(taskId, "epic-child");
  }

  /** Release a reservation only after the persisted run has reached a terminal state. */
  releaseTask(taskId: string): void {
    this.db.run("DELETE FROM scheduler_capacity_reservations WHERE task_id=$taskId", { taskId });
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
