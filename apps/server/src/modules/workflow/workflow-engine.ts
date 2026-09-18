/**
 * Workflow engine – deterministic state machine for task transitions.
 *
 * Side-effect-free `canTransition` and transactional `transition`
 * that persists state + TaskStateChanged outbox event atomically.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { TaskStatus } from "../work/work-types.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import type { WorkflowRegistry } from "./workflow-registry.js";
import type { TransitionContext, WorkflowTemplate } from "./workflow-types.js";

/** Template name for standalone (non-epic) tasks. */
const STANDALONE_TEMPLATE = "standard";

/** Template name for tasks that belong to an epic. */
const EPIC_CHILD_TEMPLATE = "architecture_change";

interface TaskRow {
  id: string;
  status: string;
  epic_id: string | null;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class WorkflowEngine {
  constructor(
    private readonly db: Database,
    private readonly registry: WorkflowRegistry,
  ) {}

  /**
   * Check whether a transition is allowed without persisting anything.
   *
   * Returns `false` when:
   * - the task does not exist
   * - the template is not registered
   * - the transition is not in the template
   * - required context conditions are not met
   */
  canTransition(
    taskId: string,
    toStatus: TaskStatus,
    context?: TransitionContext,
  ): boolean {
    const row = this.db.get<TaskRow>(
      "SELECT id, status, epic_id FROM tasks WHERE id = $id",
      { id: taskId },
    );
    if (!row) return false;

    const template = this.getTaskTemplate(row);
    if (!template) return false;

    if (toStatus === "RELEASED" && row.epic_id && !this.epicMergeCompleted(row.epic_id)) return false;
    return this.evaluateTransition(
      row.status as TaskStatus,
      toStatus,
      template,
      context,
    );
  }

  /**
   * Execute a transition: update status and emit TaskStateChanged outbox event
   * within a single transaction.
   *
   * Throws if the transition is not allowed.
   */
  transition(
    taskId: string,
    toStatus: TaskStatus,
    context?: TransitionContext,
  ): { id: string; status: TaskStatus; updatedAt: string } {
    return this.db.transaction((tx) => this.transitionInTransaction(tx, taskId, toStatus, context));
  }

  /** Apply a transition while the caller owns a larger domain transaction. */
  transitionInTransaction(
    tx: DatabaseTx,
    taskId: string,
    toStatus: TaskStatus,
    context?: TransitionContext,
  ): { id: string; status: TaskStatus; updatedAt: string } {
      const row = tx.get<TaskRow>(
        "SELECT id, status, epic_id FROM tasks WHERE id = $id",
        { id: taskId },
      );
      if (!row) {
        throw new Error(`Task ${taskId} not found`);
      }

      const fromStatus = row.status as TaskStatus;
      const template = this.getTaskTemplateFromTx(tx, row);
      if (!template) {
        throw new Error(
          `No workflow template registered for task ${taskId}`,
        );
      }

      if (toStatus === "RELEASED" && row.epic_id && !this.epicMergeCompleted(row.epic_id, tx)) {
        throw new Error(`Transition to RELEASED is not allowed by template: Epic child ${taskId} cannot be released before final Epic merge completion`);
      }
      if (!this.evaluateTransition(fromStatus, toStatus, template, context)) {
        throw new Error(
          `Transition ${fromStatus} → ${toStatus} is not allowed by template "${template.name}"`,
        );
      }

      // Persist the status change
      const now = new Date().toISOString();
      tx.run(
        "UPDATE tasks SET status = $status, updated_at = $updated_at WHERE id = $id",
        { id: taskId, status: toStatus, updated_at: now },
      );

      // Append the outbox event in the same transaction
      const event = DomainEvent.create({
        type: "TaskStateChanged",
        aggregateType: "Task",
        aggregateId: taskId,
        payload: {
          taskId,
          fromStatus,
          toStatus,
        },
      });
      appendOutboxEvent(tx, event);

      return { id: taskId, status: toStatus, updatedAt: now };
  }

  /**
   * Return the current workflow stage (status) of a task.
   */
  currentStage(taskId: string): TaskStatus | undefined {
    const row = this.db.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    return row?.status as TaskStatus | undefined;
  }

  // ── Private helpers ──

  /**
   * Determine which template applies to a task based on its epic_id.
   */
  private getTaskTemplate(row: TaskRow): WorkflowTemplate | undefined {
    const name = row.epic_id ? EPIC_CHILD_TEMPLATE : STANDALONE_TEMPLATE;
    return this.registry.get(name);
  }

   private getTaskTemplateFromTx(
     _tx: DatabaseTx,
     row: TaskRow,
   ): WorkflowTemplate | undefined {
     const name = row.epic_id ? EPIC_CHILD_TEMPLATE : STANDALONE_TEMPLATE;
     return this.registry.get(name);
   }

  /**
   * Evaluate whether a transition is allowed according to the template rules.
   */
  private evaluateTransition(
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    template: WorkflowTemplate,
    context?: TransitionContext,
  ): boolean {
    // Self-transitions are never allowed
    if (fromStatus === toStatus) return false;

    // Child Tasks are already integrated into the Epic branch at this point;
    // their release is a release marker, not a second child merge.
    if (fromStatus === "INTEGRATED_INTO_EPIC" && toStatus === "RELEASED") {
      return context?.parentEpicReleased === true;
    }

    // Check if the statuses are valid stages in this template
    if (
      !template.stages.includes(fromStatus) ||
      !template.stages.includes(toStatus)
    ) {
      return false;
    }

    // Find a matching transition rule
    const rule = template.transitions.find(
      (r) => r.from === fromStatus && r.to === toStatus,
    );
    if (!rule) return false;

    // Check context requirements
    if (rule.requires && rule.requires.length > 0) {
      if (!context) return false;
      for (const key of rule.requires) {
        if (!context[key]) return false;
      }
    }

    return true;
  }

  private epicMergeCompleted(epicId: string, source: Database | DatabaseTx = this.db): boolean {
    return source.get<{ status: string }>("SELECT status FROM epics WHERE id = $epicId", { epicId })?.status === "DONE";
  }
}
