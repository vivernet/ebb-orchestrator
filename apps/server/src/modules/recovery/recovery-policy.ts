/**
 * Recovery policy - deterministic recovery engine with exact counters.
 */

import { DEFAULT_POLICY, type RecoveryPolicy, type RecoveryContext, type RecoveryResult, type RoleLevel, type FailureType } from "./recovery-types.js";
import { createNoProgressFingerprint } from "./progress-fingerprint.js";

/**
 * Counts attempts for a specific role and failure type.
 */
export function countAttempts(
  attempts: RecoveryContext["attempts"],
  roleLevel: RoleLevel,
  failureType: FailureType,
): number {
  return attempts.filter(
    (a) => a.roleLevel === roleLevel && a.failureType === failureType,
  ).length;
}

/**
 * Checks if the same evidence fingerprint appears repeatedly (loop detection).
 */
export function hasLoopInEvidence(
  attempts: RecoveryContext["attempts"],
  stage: string,
  evidenceHash: string,
  maxCycles: number,
): boolean {
  return attempts.filter(
    (a) => a.fingerprint?.stage === stage && a.fingerprint?.evidenceHash === evidenceHash,
  ).length >= maxCycles;
}

/**
 * Checks if there have been too many consecutive no-progress runs.
 */
export function hasExcessiveNoProgress(
  attempts: RecoveryContext["attempts"],
  stage: string,
  maxRuns: number,
): boolean {
  return attempts.filter(
    (a) => a.fingerprint?.stage === stage && a.fingerprint?.evidenceHash === "no_progress",
  ).length >= maxRuns;
}

/**
 * Evaluates recovery decision based on policy and context.
 */
export function evaluateRecovery(context: RecoveryContext, policy: RecoveryPolicy = DEFAULT_POLICY): RecoveryResult {
  const { attempts, currentRoleLevel, failureType, stage, evidenceHash } = context;
  
  // Count attempts at current level
  const attemptsAtLevel = countAttempts(attempts, currentRoleLevel, failureType);

  // Handle TOOL_ERROR - always retry, never escalate
  if (failureType === "TOOL_ERROR") {
    return {
      decision: "RETRY",
      reason: "Tool errors are infrastructure issues and should never trigger role escalation",
      createSchedulerRequest: true,
    };
  }

  // Handle no-progress detection
  if (failureType === "NO_PROGRESS" && stage) {
    const noProgressCount = attempts.filter(
      (a) => a.fingerprint?.stage === stage && a.fingerprint?.evidenceHash === "no_progress",
    ).length;

    if (noProgressCount >= policy.maxConsecutiveNoProgressRuns) {
      if (currentRoleLevel === "middle") {
        return {
          decision: "ESCALATE_ROLE",
          nextRoleLevel: "senior",
          reason: "Excessive no-progress runs at middle tier",
          createSchedulerRequest: true,
        };
      } else {
        // Senior exhausted
        return {
          decision: "COORDINATOR_DIAGNOSIS",
          reason: "Senior tier exhausted on no-progress issue",
          createSchedulerRequest: false,
        };
      }
    }
  }

  // Handle loop detection for review/QA findings
  if (stage && evidenceHash) {
    if (stage === "review" && hasLoopInEvidence(attempts, stage, evidenceHash, policy.maxReviewReworkCycles)) {
      if (currentRoleLevel === "middle") {
        return {
          decision: "ESCALATE_ROLE",
          nextRoleLevel: "senior",
          reason: "Same review finding loop detected at middle tier",
          createSchedulerRequest: true,
        };
      } else {
        return {
          decision: "COORDINATOR_DIAGNOSIS",
          reason: "Same review finding loop detected at senior tier",
          createSchedulerRequest: false,
        };
      }
    }

    if (stage === "qa" && hasLoopInEvidence(attempts, stage, evidenceHash, policy.maxQaReworkCycles)) {
      if (currentRoleLevel === "middle") {
        return {
          decision: "ESCALATE_ROLE",
          nextRoleLevel: "senior",
          reason: "Same QA finding loop detected at middle tier",
          createSchedulerRequest: true,
        };
      } else {
        return {
          decision: "COORDINATOR_DIAGNOSIS",
          reason: "Same QA finding loop detected at senior tier",
          createSchedulerRequest: false,
        };
      }
    }
  }

  // Handle integration failures
  if (failureType === "INTEGRATION_FAILURE") {
    const integrationAttempts = attempts.filter(
      (a) => a.failureType === "INTEGRATION_FAILURE",
    ).length;

    if (integrationAttempts >= policy.maxIntegrationResolutionAttempts) {
      return {
        decision: "COORDINATOR_DIAGNOSIS",
        reason: "Maximum integration resolution attempts exceeded",
        createSchedulerRequest: false,
      };
    }

    return {
      decision: "RETRY",
      reason: "Integration failure within resolution attempts",
      createSchedulerRequest: true,
    };
  }

  // Handle TASK_FAILURE
  if (failureType === "TASK_FAILURE") {
    if (currentRoleLevel === "middle") {
      if (attemptsAtLevel < policy.middleAttempts) {
        return {
          decision: "RESUME_SAME_SESSION",
          reason: "First task failure at middle tier - resume same session",
          createSchedulerRequest: false,
        };
      }
      // Middle exhausted, escalate to senior
      return {
        decision: "ESCALATE_ROLE",
        nextRoleLevel: "senior",
        reason: "Middle tier exhausted on task failure",
        createSchedulerRequest: true,
      };
    } else {
      // Senior tier
      if (attemptsAtLevel < policy.seniorAttempts) {
        return {
          decision: "RETRY",
          reason: "First task failure at senior tier - retry",
          createSchedulerRequest: true,
        };
      }
      // Senior exhausted
      return {
        decision: "COORDINATOR_DIAGNOSIS",
        reason: "Senior tier exhausted on task failure",
        createSchedulerRequest: false,
      };
    }
  }

  // Default: block
  return {
    decision: "BLOCK",
    reason: "No recovery path available",
    createSchedulerRequest: false,
  };
}

/**
 * Calculates remaining attempts at a given role level.
 */
export function getRemainingAttempts(
  attempts: RecoveryContext["attempts"],
  roleLevel: RoleLevel,
  failureType: FailureType,
  policy: RecoveryPolicy = DEFAULT_POLICY,
): number {
  const maxAttempts = roleLevel === "middle" ? policy.middleAttempts : policy.seniorAttempts;
  const currentAttempts = countAttempts(attempts, roleLevel, failureType);
  return Math.max(0, maxAttempts - currentAttempts);
}
