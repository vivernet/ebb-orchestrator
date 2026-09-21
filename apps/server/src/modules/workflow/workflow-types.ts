/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import type { TaskStatus } from "../work/work-types.js";

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export interface TransitionContext {
  hasReviewPassed: boolean;
  hasSuccessfulIntegration: boolean;
  hasFinalMergeApproval: boolean;
  parentEpicReleased: boolean;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export interface TransitionRule {
  from: TaskStatus;
  to: TaskStatus;
  /** Keys of TransitionContext that must be truthy for this transition to be allowed. */
  requires?: readonly (keyof TransitionContext)[];
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
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
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export interface TransitionResult {
  readonly task: {
    readonly id: string;
    readonly status: TaskStatus;
    readonly updatedAt: string;
  };
}
