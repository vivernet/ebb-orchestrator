/**
 * Recovery domain types - recovery decisions and fingerprints.
 */

/**
 * Recovery decision indicating the next action to take.
 */
export type RecoveryDecision =
  | "RESUME_SAME_SESSION"
  | "RETRY"
  | "ESCALATE_ROLE"
  | "COORDINATOR_DIAGNOSIS"
  | "BLOCK";

/**
 * Stage-specific evidence for tracking progress and detecting loops.
 */
export interface ProgressFingerprint {
  /** Stage identifier (e.g., "review", "qa", "integration"). */
  stage: string;
  /** Hash or identifier of the evidence (e.g., review finding). */
  evidenceHash: string;
  /** Timestamp when this evidence was recorded. */
  recordedAt: string;
}

/**
 * Recovery policy configuration with exact counters.
 */
export interface RecoveryPolicy {
  /** Maximum attempts allowed at middle tier before escalation. */
  middleAttempts: number;
  /** Maximum attempts allowed at senior tier before escalation. */
  seniorAttempts: number;
  /** Maximum rework cycles for the same review finding. */
  maxReviewReworkCycles: number;
  /** Maximum rework cycles for the same QA finding. */
  maxQaReworkCycles: number;
  /** Maximum resolution attempts for integration failures. */
  maxIntegrationResolutionAttempts: number;
  /** Maximum consecutive runs without progress before escalation. */
  maxConsecutiveNoProgressRuns: number;
}

/**
 * Default recovery policy configuration.
 */
export const DEFAULT_POLICY: RecoveryPolicy = {
  middleAttempts: 2,
  seniorAttempts: 2,
  maxReviewReworkCycles: 3,
  maxQaReworkCycles: 3,
  maxIntegrationResolutionAttempts: 2,
  maxConsecutiveNoProgressRuns: 2,
} as const;

/**
 * Role level for task execution.
 */
export type RoleLevel = "middle" | "senior";

/**
 * Failure type for categorizing recovery needs.
 */
export type FailureType =
  | "TASK_FAILURE"
  | "TOOL_ERROR"
  | "INTEGRATION_FAILURE"
  | "REVIEW_FINDING"
  | "QA_FINDING"
  | "NO_PROGRESS";

/**
 * Recovery attempt record.
 */
export interface RecoveryAttempt {
  /** Task ID being recovered. */
  taskId: string;
  /** Role level that attempted the recovery. */
  roleLevel: RoleLevel;
  /** Type of failure that triggered recovery. */
  failureType: FailureType;
  /** Attempt number for this failure type and role. */
  attemptCount: number;
  /** Timestamp of the attempt. */
  timestamp: string;
  /** Progress fingerprint if applicable. */
  fingerprint?: ProgressFingerprint;
}

/**
 * Context needed to evaluate recovery decisions.
 */
export interface RecoveryContext {
  /** Task ID being evaluated. */
  taskId: string;
  /** Current role level. */
  currentRoleLevel: RoleLevel;
  /** List of recovery attempts for this task. */
  attempts: RecoveryAttempt[];
  /** Current failure type. */
  failureType: FailureType;
  /** Current stage if applicable. */
  stage?: string;
  /** Evidence hash for finding tracking. */
  evidenceHash?: string;
}

/**
 * Result of recovery evaluation.
 */
export interface RecoveryResult {
  /** The recovery decision to make. */
  decision: RecoveryDecision;
  /** Recommended role level for next attempt. */
  nextRoleLevel?: RoleLevel;
  /** Reason for the decision. */
  reason: string;
  /** If a new scheduler request should be created. */
  createSchedulerRequest: boolean;
}
