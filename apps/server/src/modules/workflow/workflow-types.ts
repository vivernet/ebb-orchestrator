/**
 * Workflow domain types – templates and engine interfaces.
 */

import type { TaskStatus } from "../work/work-types.js";

/**
 * External state that the transition engine needs to evaluate
 * context-dependent rules (approval gates, integration markers, etc.).
 */
export interface TransitionContext {
  hasReviewPassed: boolean;
  hasSuccessfulIntegration: boolean;
  hasFinalMergeApproval: boolean;
  parentEpicReleased: boolean;
}

/**
 * A single allowed transition with optional context requirements.
 */
export interface TransitionRule {
  from: TaskStatus;
  to: TaskStatus;
  /** Keys of TransitionContext that must be truthy for this transition to be allowed. */
  requires?: readonly (keyof TransitionContext)[];
}

/**
 * A workflow template defines allowed stages and transitions for a particular
 * workflow type (e.g. standard task, bugfix, architecture change).
 */
export interface WorkflowTemplate {
  readonly name: string;
  readonly description: string;
  /** All statuses that are valid stages in this workflow. */
  readonly stages: readonly TaskStatus[];
  /** Allowed transitions with optional context requirements. */
  readonly transitions: readonly TransitionRule[];
}

/**
 * Result of a successful transition.
 */
export interface TransitionResult {
  readonly task: {
    readonly id: string;
    readonly status: TaskStatus;
    readonly updatedAt: string;
  };
}
