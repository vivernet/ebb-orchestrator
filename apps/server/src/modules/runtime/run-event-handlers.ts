/**
 * событие handlers для runtime orchestration.
 * Handles AgentRunRequested события и runtime completion события.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { RunOutcome } from "./run-types.js";
import { validateRoleOutput } from "./output-validator.js";
import { SchedulerService } from "../scheduler/scheduler-service.js";
import { createRunContextInput, RunService, taskDeveloperPrompt, taskQaPrompt, taskReviewerPrompt } from "./run-service.js";
import { WorktreeRepository } from "../git/worktree-repository.js";
import { assertSafeGitRef, GitCli } from "../git/git-cli.js";

/**
 * Orchestrates runtime события и workflow transitions.
 */
export class RuntimeEventHandlers {
  constructor(
    private readonly db: Database,
    private readonly workflowEngine: WorkflowEngine,
    private readonly scheduler: SchedulerService,
    private readonly runService?: RunService,
    private readonly git: Pick<GitCli, "run"> = new GitCli(),
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
  }): Promise<void> {
    if (event.type !== "AgentRunRequested" || !event.aggregateId) {
      return;
    }

    const taskId = event.aggregateId;
    const roleValue = event.payload.role === undefined ? "developer" : event.payload.role;
    const modelValue = event.payload.model === undefined ? "test-model" : event.payload.model;
    if (typeof roleValue !== "string" || !["developer", "reviewer", "qa", "integration"].includes(roleValue.toLowerCase())) throw new Error("TASK_RUN_ROLE_UNSUPPORTED");
    if (typeof modelValue !== "string" || modelValue.trim() === "") throw new Error("TASK_RUN_MODEL_INVALID");
    if (!this.runService) throw new Error("RUN_PREPARATION_SERVICE_UNAVAILABLE");
    const role = roleValue.toLowerCase() as "developer" | "reviewer" | "qa" | "integration";
    const model = modelValue;

    // Проверяет task exists and is in READY state
    const task = this.db.get<{ id: string; status: string; project_id: string; epic_id: string | null }>(
      "SELECT id, status, project_id, epic_id FROM tasks WHERE id = $id",
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

    const worktree = new WorktreeRepository(this.db).findTaskWorkspace(taskId);
    if (!worktree) throw new Error("TASK_MANAGED_WORKSPACE_UNAVAILABLE");
    const targetHead = (await this.git.run(worktree.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    const actualBranch = (await this.git.run(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (!/^[a-f0-9]{40}$/i.test(targetHead) || actualBranch !== worktree.branch) throw new Error("TASK_WORKTREE_SNAPSHOT_UNAVAILABLE");
    let prompt: string;
    let roleInputs: unknown;
    if (role === "developer") {
      prompt = taskDeveloperPrompt();
    } else if (role === "reviewer") {
      const operation = this.db.get<{ target_ref: string | null }>(
        `SELECT target_ref FROM git_operations WHERE type='CREATE_WORKTREE' AND status='VERIFIED'
           AND repo_path=$repoPath AND branch_name=$branch AND worktree_id=$taskId ORDER BY verified_at DESC LIMIT 1`,
        { repoPath: worktree.repoPath, branch: worktree.branch, taskId },
      );
      if (!operation?.target_ref) throw new Error("TASK_REVIEW_BASE_UNAVAILABLE");
      assertSafeGitRef(operation.target_ref);
      const gitDiff = (await this.git.run(worktree.path, ["diff", "--no-ext-diff", "--no-textconv", `${operation.target_ref}...HEAD`, "--"])).stdout;
      prompt = taskReviewerPrompt();
      roleInputs = { gitDiff, checks: [] };
    } else if (role === "qa") {
      prompt = taskQaPrompt();
      roleInputs = { environment: `Managed task worktree branch ${actualBranch} at target SHA ${targetHead} on ${process.platform}.` };
    } else {
      throw new Error("TASK_INTEGRATION_REQUIRES_PREPARED_ATTEMPT");
    }
    this.scheduler.assertProjectDispatchable(task.project_id);

    const runOptions = {
      role,
      model,
      taskId,
      epicId: task.epic_id,
      triggerReason: "runtime-request",
      contextVersion: "runtime-request-v1",
      outputSchemaVersion: "1",
      capability: { workspace: worktree.path },
    } as const;
    const run = await this.runService.prepareRunWithHermesPreflight({
      ...runOptions,
      contextInput: createRunContextInput(runOptions, {
        prompt,
        ...(roleInputs !== undefined ? { roleInputs } : {}),
        workspaceIdentity: { repository: worktree.repoPath, workspace: worktree.path, worktree: worktree.id },
        targetHead,
        targetBranch: actualBranch,
      }),
    });

    try {
      // Scheduler является Объект только dispatch authority: it atomically reserves
      // capacity/budget/resource lock перед advancing Объект workflow.
      this.scheduler.dispatchTask(taskId, this.workflowEngine, () => undefined, {
        triggerReason: "runtime-request",
        role,
        model: run.model,
        runId: run.id,
      });
    } catch (error) {
      if (this.runService.failPreparedRun(run.id, error)) this.scheduler.releaseTask(taskId, 0);
      throw error;
    }

    this.emitAgentRunStarted(taskId, role, run.model);
    await this.executePreparedRun(taskId, run.id);
    return;
  }

  /** Executes Объект scheduler-bound run и applies только its persisted outcome. */
  private async executePreparedRun(taskId: string, runId: string): Promise<void> {
    try {
      const execution = await this.runService!.executePreparedRun(runId);
      this.handleRuntimeCompletion(runId, execution.outcome);
    } catch (error) {
      if (this.runService!.failPreparedRun(runId, error)) this.scheduler.releaseTask(taskId, 0);
      throw error;
    }
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
    // Проверяет current workflow stage
    const currentStage = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!currentStage) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Только allow completion from DEVELOPMENT stage
    if (currentStage.status !== "DEVELOPMENT") {
      throw new Error(
        `Invalid workflow stage for completion: ${currentStage.status}. Expected: DEVELOPMENT`,
      );
    }

    // Применяет outcome based on success/failure
    const successfulOutcome = !["BLOCKED", "FAIL", "CHANGES_REQUESTED"].includes(validation.outcome ?? "");
    const targetStatus = successfulOutcome ? "REVIEW" : "FAILED";
    this.workflowEngine.transition(taskId, targetStatus);

    // Emit appropriate событие
    if (successfulOutcome) {
      this.emitAgentRunCompleted(taskId, outcome);
    } else {
      this.emitAgentRunFailed(taskId, outcome);
    }
    this.scheduler.releaseTask(taskId, run.cost ?? 0);
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

    // Переход к CANCELLED.
    this.workflowEngine.transition(taskId, "CANCELLED");
    this.scheduler.releaseTask(taskId);
    this.emitAgentRunInterrupted(taskId);
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
  private emitAgentRunStarted(
    taskId: string,
    role: string,
    model: string,
  ): void {
    // в production, этот would append to outbox
    // Для now, we log it
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
