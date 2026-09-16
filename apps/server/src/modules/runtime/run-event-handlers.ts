/**
 * Event handlers for runtime orchestration.
 * Handles AgentRunRequested events and runtime completion events.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { FindingsService } from "../work/findings-service.js";
import { DefectsService } from "../work/defects-service.js";
import type { RunOutcome } from "./run-types.js";

/**
 * Orchestrates runtime events and workflow transitions.
 */
export class RuntimeEventHandlers {
  constructor(
    private readonly db: Database,
    private readonly workflowEngine: WorkflowEngine,
    private readonly findingsService: FindingsService,
    private readonly defectsService: DefectsService,
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
    taskId: string,
    outcome: RunOutcome,
    role: string = "Developer",
    model: string = "test-model",
    findings?: Array<{
      title: string;
      description: string;
      severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
      blocking: boolean;
      guidelineRef?: string | null;
      evidenceSignature: string;
    }>,
    defects?: Array<{
      title: string;
      description: string;
      severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
      blocking: boolean;
      acceptanceCriterionRef?: string | null;
      evidenceSignature: string;
    }>,
  ): void {
    // Validate current workflow stage
    const currentStage = this.db.get<{ status: string; project_id: string }>(
      "SELECT status, project_id FROM tasks WHERE id = $id",
      { id: taskId },
    );

    if (!currentStage) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Handle findings for Reviewer/QA roles
    if ((role === "Reviewer" || role === "QA") && findings && findings.length > 0) {
      const projectId = currentStage.project_id;
      const existingOpenFindings = this.findingsService.getOpenFindingsByTaskId(this.db, taskId);

      for (const f of findings) {
        // Check if finding already exists by matching evidence signature
        const existing = existingOpenFindings.find(
          (ef) => ef.evidenceSignature === f.evidenceSignature,
        );

        if (existing) {
          // Update existing finding (re-review)
          this.findingsService.updateFinding(existing.id, {
            status: f.blocking ? "STILL_PRESENT" : "RESOLVED",
            evidenceSignature: f.evidenceSignature,
          });
        } else {
          // Create new finding
          this.findingsService.createFinding(projectId, taskId, {
            sourceRunId: taskId, // placeholder - actual run id would come from runtime
            severity: f.severity,
            blocking: f.blocking,
            title: f.title,
            description: f.description,
            guidelineRef: f.guidelineRef ?? null,
            evidenceSignature: f.evidenceSignature,
          });
        }
      }
    }

    // Handle defects for QA role
    if (role === "QA" && defects && defects.length > 0) {
      const projectId = currentStage.project_id;
      const existingOpenDefects = this.defectsService.getOpenDefectsByTaskId(this.db, taskId);

      for (const d of defects) {
        // Check if defect already exists by matching evidence signature
        const existing = existingOpenDefects.find(
          (ed) => ed.evidenceSignature === d.evidenceSignature,
        );

        if (existing) {
          // Update existing defect (re-test)
          this.defectsService.updateDefect(existing.id, {
            status: d.blocking ? "STILL_PRESENT" : "RESOLVED",
            evidenceSignature: d.evidenceSignature,
          });
        } else {
          // Create new defect
          this.defectsService.createDefect(projectId, taskId, {
            sourceRunId: taskId, // placeholder - actual run id would come from runtime
            severity: d.severity,
            blocking: d.blocking,
            title: d.title,
            description: d.description,
            acceptanceCriterionRef: d.acceptanceCriterionRef ?? null,
            evidenceSignature: d.evidenceSignature,
          });
        }
      }
    }

    // Only allow completion from DEVELOPMENT stage
    if (currentStage.status !== "DEVELOPMENT") {
      throw new Error(
        `Invalid workflow stage for completion: ${currentStage.status}. Expected: DEVELOPMENT`,
      );
    }

    // Apply outcome based on success/failure
    const targetStatus = outcome.success ? "REVIEW" : "FAILED";
    this.workflowEngine.transition(taskId, targetStatus);

    // Emit appropriate event
    if (outcome.success) {
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
