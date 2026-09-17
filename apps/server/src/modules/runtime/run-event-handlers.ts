/**
 * Event handlers for runtime orchestration.
 * Handles AgentRunRequested events and runtime completion events.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { RunOutcome } from "./run-types.js";
import { validateRoleOutput } from "./output-validator.js";

/**
 * Orchestrates runtime events and workflow transitions.
 */
export class RuntimeEventHandlers {
  constructor(
    private readonly db: Database,
    private readonly workflowEngine: WorkflowEngine,
  ) {}

  /**
   * Handle AgentRunRequested event.
   * Transitions task to DEVELOPMENT and starts the runtime.
   */
  handleAgentRunRequested(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void {
    if (event.type !== "AgentRunRequested" || !event.aggregateId) {
      return;
    }

    const taskId = event.aggregateId;
    const { role = "Developer", model = "test-model" } = event.payload as {
      role?: string;
      model?: string;
    };

    // Validate task exists and is in READY state
    const task = this.db.get<{ id: string; status: string }>(
      "SELECT id, status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== "READY") {
      throw new Error(
        `Task ${taskId} is not in READY state. Current status: ${task.status}`,
      );
    }

    // Transition to DEVELOPMENT (workflow engine is the only domain service that can do this)
    this.workflowEngine.transition(taskId, "DEVELOPMENT");

    // Log/emit AgentRunStarted event
    this.emitAgentRunStarted(taskId, role, model);
  }

  /**
   * Handle runtime completion.
   * Validates current workflow stage before applying outcome.
   */
  handleRuntimeCompletion(
    runId: string,
    outcome: RunOutcome,
  ): void {
    // The run is the authorization boundary. Never select a latest run for a
    // task: that permits a stale/foreign completion to advance the workflow.
    const run = this.db.get<{ id: string; task_id: string | null; role: string; status: string; output: string | null }>(
      "SELECT id, task_id, role, status, output FROM agent_runs WHERE id = $id",
      { id: runId },
    );
    if (!run) throw new Error(`Run ${runId} not found`);
    if (!run.task_id) throw new Error(`Run ${runId} is not bound to a task`);
    if (run.status !== "COMPLETED" || !run.output) {
      throw new Error(`Run ${runId} has no persisted submitted result`);
    }
    if (outcome.diagnostics?.runId !== runId) {
      throw new Error(`Run completion diagnostics do not match run ${runId}`);
    }
    let submitted: unknown;
    try { submitted = JSON.parse(run.output) as unknown; } catch {
      throw new Error(`Run ${runId} result is not valid JSON`);
    }
    const validation = validateRoleOutput(run.role.toLowerCase(), submitted);
    if (!validation.valid) throw new Error(`Run ${runId} result rejected: ${validation.error}`);

    const taskId = run.task_id;
    // Validate current workflow stage
    const currentStage = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!currentStage) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Only allow completion from DEVELOPMENT stage
    if (currentStage.status !== "DEVELOPMENT") {
      throw new Error(
        `Invalid workflow stage for completion: ${currentStage.status}. Expected: DEVELOPMENT`,
      );
    }

    // Apply outcome based on success/failure
    const successfulOutcome = !["BLOCKED", "FAIL", "CHANGES_REQUESTED"].includes(validation.outcome ?? "");
    const targetStatus = successfulOutcome ? "REVIEW" : "FAILED";
    this.workflowEngine.transition(taskId, targetStatus);

    // Emit appropriate event
    if (successfulOutcome) {
      this.emitAgentRunCompleted(taskId, outcome);
    } else {
      this.emitAgentRunFailed(taskId, outcome);
    }
  }

  /**
   * Handle interrupted run.
   */
  handleRunInterrupted(taskId: string): void {
    const currentStage = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!currentStage) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Only allow interrupt from non-terminal stages
    const terminalStates = ["FAILED", "CANCELLED", "DONE", "RELEASED"];
    if (terminalStates.includes(currentStage.status)) {
      throw new Error(
        `Cannot interrupt task in terminal state: ${currentStage.status}`,
      );
    }

    // Transition to CANCELLED
    this.workflowEngine.transition(taskId, "CANCELLED");
    this.emitAgentRunInterrupted(taskId);
  }

  /**
   * Handle ApprovalApproved event with FINAL_MERGE.
   * Validates transition to MERGING after approval.
   */
  handleApprovalApproved(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void {
    if (event.type !== "ApprovalApproved" || !event.aggregateId) {
      return;
    }

    const taskId = event.aggregateId;
    const { approvalType } = event.payload as { approvalType?: string };

    if (approvalType !== "FINAL_MERGE") {
      return;
    }

    // Task should be in READY_FOR_MERGE stage
    const task = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!task || task.status !== "READY_FOR_MERGE") {
      throw new Error(
        `Task ${taskId} is not in READY_FOR_MERGE state. Current status: ${task?.status}`,
      );
    }

    // Transition to MERGING
    this.workflowEngine.transition(taskId, "MERGING", {
      hasReviewPassed: false,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: true,
      parentEpicReleased: false,
    });

    this.emitTaskTransitioned(taskId, "READY_FOR_MERGE", "MERGING");
  }

  /** Complete the Epic merge and only then release its integrated children. */
  handleEpicMergeCompleted(epicId: string, approvalId: string): void {
    const orchestration = this.db.get<{ stage: string; final_approval_id: string | null }>(
      "SELECT stage, final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!orchestration || orchestration.final_approval_id !== approvalId || !["FINAL_APPROVAL", "DONE"].includes(orchestration.stage)) {
      throw new Error(`Epic ${epicId} has no matching persisted final approval`);
    }
    const approval = this.db.get<{ type: string; subject_id: string; subject_type: string; status: string }>(
      "SELECT type, subject_id, subject_type, status FROM approvals WHERE id=$approvalId", { approvalId });
    if (!approval || approval.type !== "FINAL_MERGE" || approval.subject_type !== "EPIC" || approval.subject_id !== epicId || approval.status !== "APPROVED") {
      throw new Error(`Approval ${approvalId} is not an approved FINAL_MERGE for Epic ${epicId}`);
    }
    const epic = this.db.get<{ status: string; display_id: string }>("SELECT status, display_id FROM epics WHERE id=$epicId", { epicId });
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    const mergeOperation = this.db.get<{ id: string }>(
      "SELECT id FROM git_operations WHERE type='MERGE' AND status='VERIFIED' AND target_ref='master' AND branch_name=$branch ORDER BY verified_at DESC LIMIT 1",
      { branch: `epic/${epic.display_id}` },
    );
    if (!mergeOperation) throw new Error(`Epic ${epicId} has no persisted successful Merge Service operation for master`);
    if (epic.status === "DONE") return;
    if (epic.status !== "IN_PROGRESS") throw new Error(`Epic ${epicId} is not ready for final merge`);
    const remaining = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tasks WHERE epic_id=$epicId AND required=1 AND status <> 'INTEGRATED_INTO_EPIC'",
      { epicId },
    );
    if ((remaining?.count ?? 1) !== 0) throw new Error(`Epic ${epicId} has required children that are not integrated`);
    this.db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run("UPDATE epics SET status='DONE', updated_at=$updatedAt WHERE id=$epicId AND status='IN_PROGRESS'", { epicId, updatedAt: now });
      const children = tx.all<{ id: string; status: string }>("SELECT id, status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId });
      for (const child of children) {
        if (child.status === "RELEASED") continue;
        if (child.status !== "INTEGRATED_INTO_EPIC") throw new Error(`Epic ${epicId} child ${child.id} is not integrated`);
        this.workflowEngine.transitionInTransaction(tx, child.id, "RELEASED", {
          hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: true, parentEpicReleased: true,
        });
      }
      tx.run("UPDATE epic_orchestrations SET stage='DONE', updated_at=$updatedAt WHERE epic_id=$epicId", { epicId, updatedAt: now });
      });
  }

  /**
   * Private helper methods for emitting events.
   */
  private emitAgentRunStarted(
    taskId: string,
    role: string,
    model: string,
  ): void {
    // In production, this would append to outbox
    // For now, we log it
    console.log(`[AgentRunStarted] taskId=${taskId} role=${role} model=${model}`);
  }

  private emitAgentRunCompleted(
    taskId: string,
    outcome: RunOutcome,
  ): void {
    console.log(
      `[AgentRunCompleted] taskId=${taskId} exitCode=${outcome.exitCode}`,
    );
  }

  private emitAgentRunFailed(
    taskId: string,
    outcome: RunOutcome,
  ): void {
    console.log(
      `[AgentRunFailed] taskId=${taskId} exitCode=${outcome.exitCode}`,
    );
  }

  private emitAgentRunInterrupted(taskId: string): void {
    console.log(`[AgentRunInterrupted] taskId=${taskId}`);
  }

  private emitTaskTransitioned(
    taskId: string,
    fromStatus: string,
    toStatus: string,
  ): void {
    console.log(
      `[TaskTransitioned] taskId=${taskId} from=${fromStatus} to=${toStatus}`,
    );
  }
}
