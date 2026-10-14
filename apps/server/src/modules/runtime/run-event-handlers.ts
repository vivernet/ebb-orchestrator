/**
 * событие handlers для runtime orchestration.
 * Handles AgentRunRequested события и runtime completion события.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { RunOutcome } from "./run-types.js";
import { validateRoleOutput } from "./output-validator.js";
import { SchedulerService } from "../scheduler/scheduler-service.js";
import { RunService } from "./run-service.js";
import { GitCli } from "../git/git-cli.js";
import { ApprovalService } from "../approvals/approval-service.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { DomainEvent } from "../../platform/events/domain-event.js";

/**
 * Orchestrates runtime события и workflow transitions.
 */
export class RuntimeEventHandlers {
  constructor(
    private readonly db: Database,
    private readonly workflowEngine: WorkflowEngine,
    private readonly scheduler: SchedulerService,
    private readonly runService?: RunService,
    _git: Pick<GitCli, "run"> = new GitCli(),
    private readonly isReady: () => boolean = () => true,
  ) {
  }

  /**
   * Обрабатывает AgentRunRequested event.
   * Transitions задача to DEVELOPMENT и запускает Объект runtime.
   */
  async handleAgentRunRequested(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): Promise<void | "deferred"> {
    if (event.type !== "AgentRunRequested" || !event.aggregateId) {
      return;
    }

    if (!this.isReady()) return "deferred";
    const taskId = event.aggregateId;
    const { requestId, runId } = event.payload;
    if (typeof requestId !== "string" || typeof runId !== "string") throw new Error("RUN_REQUEST_COMMITTED_IDENTITY_REQUIRED");
    const request = this.scheduler.getRunRequest(taskId, requestId);
    const run = this.db.get<{ task_id: string | null; role: string; status: string; output: string | null }>(
      "SELECT task_id,role,status,output FROM agent_runs WHERE id=$id", { id: runId });
    if (!request || request.status !== "DISPATCHED" || request.runId !== runId || !run || run.task_id !== taskId || run.role !== request.role) {
      throw new Error("RUN_REQUEST_COMMITTED_IDENTITY_MISMATCH");
    }
    if (run.status === "COMPLETED" && run.output) {
      if (run.role === "integration") {
        const validation = validateRoleOutput(run.role, JSON.parse(run.output) as unknown);
        // Только PASS требует доведения Integration attempt; semantic BLOCKED проецируется в FAILED.
        if (validation.valid && validation.outcome === "PASS") await this.runService?.reconcileTaskIntegrationOutcome(runId);
      }
      this.handleRuntimeCompletion(runId, storedOutcome(runId, run.output));
      return;
    }
    if (run.status === "FAILED" || run.status === "CANCELLED") return;
    if (run.status === "IN_PROGRESS" || run.status === "COMPLETING") return "deferred";
    if (!this.runService) throw new Error("RUN_PREPARATION_SERVICE_UNAVAILABLE");
    const execution = await this.runService.executeTaskRequestRun(requestId, runId, taskId, this.isReady);
    if (execution) this.handleRuntimeCompletion(runId, execution.outcome);
    else if (!this.isReady()) return "deferred";
  }

  /**
   * Обрабатывает runtime completion.
   * Validates текущий workflow этап перед applying outcome.
   */
  handleRuntimeCompletion(
    runId: string,
    outcome: RunOutcome,
  ): void {
    // Этот run is the authorization boundary. Never select a latest run for a
    // задача: который permits Объект stale/foreign completion to advance Объект workflow.
    const run = this.db.get<{ id: string; task_id: string | null; role: string; status: string; output: string | null; cost: number | null }>(
      "SELECT id, task_id, role, status, output, cost FROM agent_runs WHERE id = $id",
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
    this.db.transaction((tx) => {
      if (tx.get("SELECT run_id FROM run_completion_projections WHERE run_id=$runId", { runId })) return;
      const stage = tx.get<{ status: string; epic_id: string | null }>("SELECT status,epic_id FROM tasks WHERE id=$id", { id: taskId });
      const expected = run.role === "reviewer" ? "REVIEW" : run.role === "qa" ? "QA" : run.role === "integration" ? "INTEGRATION" : "DEVELOPMENT";
      if (!stage || (stage.status !== expected && stage.status !== "DEVELOPMENT")) throw new Error(`Invalid workflow stage for completion: ${stage?.status}. Expected: ${expected}`);
      const successful = !["BLOCKED", "FAIL", "CHANGES_REQUESTED"].includes(validation.outcome ?? "");
      if (successful && run.role === "integration") {
        const attempt = tx.get<{ status: string; source_sha: string; expected_target_sha: string }>("SELECT status,source_sha,expected_target_sha FROM integration_attempts WHERE integration_run_id=$runId", { runId });
        const result = submitted as { sourceSha?: string; baseSha?: string };
        if (!attempt || attempt.status !== "MERGED" || result.sourceSha !== attempt.source_sha || result.baseSha !== attempt.expected_target_sha) throw new Error("TASK_INTEGRATION_OUTCOME_UNVERIFIED");
      }
      const target = stage.status === "DEVELOPMENT" ? "REVIEW" : run.role === "reviewer" ? "QA" : run.role === "qa" ? "READY_FOR_INTEGRATION" : "READY_FOR_MERGE";
      this.workflowEngine.transitionInTransaction(tx, taskId, successful ? target : "FAILED", {
        hasReviewPassed: successful && run.role === "reviewer", hasSuccessfulIntegration: successful && run.role === "integration",
        hasFinalMergeApproval: false, parentEpicReleased: false,
      });
      const release = this.scheduler.releaseTaskInTransaction(tx, taskId, run.cost ?? 0);
      if (release.status === "BLOCKED_OWNERSHIP_DRIFT") throw new Error("RUN_COMPLETION_RESERVATION_OWNERSHIP_DRIFT");
      tx.run("INSERT INTO run_completion_projections(run_id,projected_at) VALUES($runId,$now)", { runId, now: new Date().toISOString() });
      if (!successful) appendOutboxEvent(tx, DomainEvent.create({ type: "AgentRunFailed", aggregateType: "AgentRun", aggregateId: runId,
        payload: { runId, taskId, role: run.role, status: "COMPLETED", taskStatus: "FAILED", outcome: validation.outcome, failureKind: "ROLE_OUTCOME" } }));
      if (successful && stage.epic_id === null) {
        if (target === "READY_FOR_MERGE") new ApprovalService(this.db).requestInTransaction(tx, {
          type: "FINAL_MERGE", subjectType: "TASK", subjectId: taskId, requestedBy: "runtime-orchestrator",
        });
        else {
          const role = target === "REVIEW" ? "reviewer" : target === "QA" ? "qa" : "integration";
          const source = tx.get<{ model: string }>("SELECT model FROM scheduler_run_requests WHERE run_id=$runId", { runId });
          this.scheduler.enqueueRunRequestInTransaction(tx, { taskId, role, model: source?.model ?? "default",
            idempotencyKey: `task-stage:${runId}:${role}`, originType: "TASK_STAGE", originId: runId });
        }
      }
    });
  }

  /**
   * Обрабатывает interrupted run.
   */
  handleRunInterrupted(taskId: string): void {
    const currentStage = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!currentStage) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Только allow interrupt from non-terminal stages
    const terminalStates = ["FAILED", "CANCELLED", "DONE", "RELEASED"];
    if (terminalStates.includes(currentStage.status)) {
      throw new Error(
        `Cannot interrupt task in terminal state: ${currentStage.status}`,
      );
    }

    this.db.transaction((tx) => {
      this.workflowEngine.transitionInTransaction(tx, taskId, "CANCELLED");
      const release = this.scheduler.releaseTaskInTransaction(tx, taskId);
      if (release.status === "BLOCKED_OWNERSHIP_DRIFT") throw new Error("RUN_INTERRUPTION_RESERVATION_OWNERSHIP_DRIFT");
      appendOutboxEvent(tx, DomainEvent.create({ type: "AgentRunInterrupted", aggregateType: "Task", aggregateId: taskId,
        payload: { taskId, previousStatus: currentStage.status, status: "CANCELLED" } }));
    });
  }

  /**
   * Обрабатывает ApprovalApproved event with FINAL_MERGE.
   * Validates transition to MERGING после approval.
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

    // задача должен be in READY_FOR_MERGE этап
    const task = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!task || task.status !== "READY_FOR_MERGE") {
      throw new Error(
        `Task ${taskId} is not in READY_FOR_MERGE state. Current status: ${task?.status}`,
      );
    }

    // Переход к MERGING.
    this.workflowEngine.transition(taskId, "MERGING", {
      hasReviewPassed: false,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: true,
      parentEpicReleased: false,
    });

    this.emitTaskTransitioned(taskId, "READY_FOR_MERGE", "MERGING");
  }

  /** Complete Объект Epic merge и только then release its integrated children. */
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
    const mergeOperation = this.db.get<{ id: string; approval_id: string; source_sha: string; expected_target_sha: string; resulting_target_sha: string }>(
      "SELECT id,approval_id,source_sha,expected_target_sha,resulting_target_sha FROM git_operations WHERE type='MERGE' AND status='VERIFIED' AND target_ref='master' AND branch_name=$branch AND approval_id=$approvalId AND source_sha IS NOT NULL AND expected_target_sha IS NOT NULL AND resulting_target_sha IS NOT NULL ORDER BY verified_at DESC LIMIT 1",
      { branch: `epic/${epic.display_id}`, approvalId },
    );
    if (!mergeOperation) throw new Error(`Epic ${epicId} has no persisted successful Merge Service operation for master`);
    if (mergeOperation.approval_id !== approvalId || !mergeOperation.source_sha || !mergeOperation.expected_target_sha || !mergeOperation.resulting_target_sha) {
      throw new Error(`Epic ${epicId} merge operation has incomplete approval/SHA provenance`);
    }
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
   * приватный helper methods для emitting события.
   */
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

function storedOutcome(runId: string, output: string): RunOutcome {
  return { success: true, exitCode: 0, output, validatedSubmission: true,
    diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
}
