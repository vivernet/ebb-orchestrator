/**
 * Scheduler service - coordinates task scheduling and eligibility evaluation.
 */

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
    // Eligibility projection and dispatch use the same durable reservation
    // authority.  In particular, non-task phases consume these slots too.
    const reservedGlobal = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'")?.count ?? 0;

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
    for (const row of this.db.all<{ project_id: string; count: number }>("SELECT project_id,COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' GROUP BY project_id")) {
      runningByProject.set(row.project_id, Math.max(runningByProject.get(row.project_id) ?? 0, row.count));
    }

    // Limit each project's runnables
    const limitedByProject: SchedulableTask[] = [];
    for (const [projectId, tasks] of runnablesByProject) {
      const running = runningByProject.get(projectId) ?? 0;
      const available = Math.max(0, CAPACITY.projectMax - running);
      limitedByProject.push(...tasks.slice(0, available));
    }

    // Then limit globally
    const globalAvailable = Math.max(0, CAPACITY.globalMax - reservedGlobal);
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
      currentRunningCount: reservedGlobal,
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
      ? "SELECT COUNT(*) as count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK' AND project_id = $project_id"
      : "SELECT COUNT(*) as count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'";

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
    triggerReasonOrOptions: string | { triggerReason?: string; approvalId?: string; role?: string; model?: string; runId?: string } = "epic-child",
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
       const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'");
       const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$projectId AND status='RESERVED' AND kind <> 'LOCK'", { projectId: task.project_id });
      if ((global?.count ?? 0) >= CAPACITY.globalMax || (project?.count ?? 0) >= CAPACITY.projectMax) {
        throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_CAPACITY`);
      }
      const existing = tx.get<{ id: string; run_id: string | null; status: string }>("SELECT id,run_id,status FROM scheduler_reservations WHERE subject_id=$taskId", { taskId });
      if (!existing || existing.status === "RELEASED") {
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
        const reservationId = existing?.id ?? crypto.randomUUID();
        const resourceKey = `task:${taskId}`;
        const externalLock = tx.get<{ owner_id: string }>("SELECT owner_id FROM scheduler_resource_locks WHERE resource_key='global'");
        if (externalLock && externalLock.owner_id !== `task:${taskId}`) throw new Error("Task " + taskId + " is not schedulable: WAITING_FOR_RESOURCE_LOCK");
        const conflictingLock = tx.get<{ reservation_id: string }>("SELECT reservation_id FROM scheduler_resource_locks WHERE resource_key=$resourceKey", { resourceKey });
        if (conflictingLock) throw new Error(`Task ${taskId} is not schedulable: WAITING_FOR_RESOURCE_LOCK`);
        if (existing) {
          tx.run("UPDATE scheduler_reservations SET project_id=$projectId,owner_id=$ownerId,reserved_at=$at,estimate_cost=$estimate,status='RESERVED',actual_cost=NULL,role='developer',model='default',approval_id=$approvalId,run_id=$runId WHERE id=$id AND status='RELEASED'", { id: reservationId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString(), estimate, approvalId: options.approvalId ?? null, runId: options.runId ?? null });
        } else {
          tx.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,approval_id,run_id) VALUES($id,'TASK',$taskId,$projectId,$ownerId,$at,$estimate,'RESERVED','developer','default',$approvalId,$runId)", { id: reservationId, taskId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString(), estimate, approvalId: options.approvalId ?? null, runId: options.runId ?? null });
        }
        tx.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES($resourceKey,$reservationId,$projectId,$ownerId,$at)", { resourceKey, reservationId, projectId: task.project_id, ownerId: `task:${taskId}`, at: new Date().toISOString() });
      } else if (options.runId !== undefined && existing.run_id !== options.runId) {
        throw new Error(`Task ${taskId} reservation run identity mismatch: expected ${options.runId}, found ${existing.run_id ?? "NULL"}`);
      }
      workflowEngine.transitionInTransaction(tx, taskId, "DEVELOPMENT");
    });
    onWorkflowRunStarted(taskId, triggerReason);
  }

  /** Reserve a non-task AI phase through the same budget/capacity authority. */
  dispatchAgentRun(runId: string, projectId: string, role: string, model: string, resourceKey = `run:${runId}`): void {
    this.db.transaction((tx) => {
      const existing = tx.get<{ status: string; run_id: string | null }>("SELECT status,run_id FROM scheduler_reservations WHERE subject_id=$runId", { runId });
      if (existing?.status === "RESERVED") {
        if (existing.run_id !== runId) {
          throw new Error(`Run ${runId} reservation run identity mismatch: expected ${runId}, found ${existing.run_id ?? "NULL"}`);
        }
        return;
      }
       const global = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'")?.count ?? 0;
       const project = tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$projectId AND status='RESERVED' AND kind <> 'LOCK'", { projectId })?.count ?? 0;
      if (global >= CAPACITY.globalMax || project >= CAPACITY.projectMax) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_CAPACITY`);
      if (tx.get("SELECT resource_key FROM scheduler_resource_locks WHERE resource_key=$resourceKey", { resourceKey })) throw new Error(`Run ${runId} is not schedulable: WAITING_FOR_RESOURCE_LOCK`);
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

  /** Reconcile a phase reservation against this exact AgentRun. */
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

  /** Release a reservation only after the persisted run has reached a terminal state. */
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

  /** Reconcile reservations and locks after a crash or interrupted run. */
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
