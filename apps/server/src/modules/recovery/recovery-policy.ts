/**
 * Политика восстановления - детерминированный recovery engine с точный counters.
 */

import { DEFAULT_POLICY, type RecoveryPolicy, type RecoveryContext, type RecoveryResult, type RoleLevel, type FailureType } from "./recovery-types.js";

/**
 * Counts попытки для Объект конкретного роль и ошибка тип.
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
 * Проверяет, Объект тот же fingerprint evidence appears repeatedly (обнаружением циклов).
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
 * Проверяет, there have been too many последовательных запусков без прогресса.
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
 * Вычисляет решение восстановления based on политика и контекст.
 */
export function evaluateRecovery(context: RecoveryContext, policy: RecoveryPolicy = DEFAULT_POLICY): RecoveryResult {
  const { attempts, currentRoleLevel, failureType, stage, evidenceHash } = context;
  
  // Подсчитывает attempts at current level
  const attemptsAtLevel = countAttempts(attempts, currentRoleLevel, failureType);

  // Обрабатывает TOOL_ERROR - always retry, never escalate
  if (failureType === "TOOL_ERROR") {
    return {
      decision: "RETRY",
      reason: "Tool errors are infrastructure issues and should never trigger role escalation",
      createSchedulerRequest: true,
    };
  }

  // Обрабатывает no-progress detection
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
        // Senior исчерпал попытки.
        return {
          decision: "COORDINATOR_DIAGNOSIS",
          reason: "Senior tier exhausted on no-progress issue",
          createSchedulerRequest: false,
        };
      }
    }
  }

  // Обрабатывает loop detection for review/QA findings
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

  // Обрабатывает integration failures
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

  // Обрабатывает TASK_FAILURE
  if (failureType === "TASK_FAILURE") {
    if (currentRoleLevel === "middle") {
      if (attemptsAtLevel < policy.middleAttempts) {
        return {
          decision: "RESUME_SAME_SESSION",
          reason: "First task failure at middle tier - resume same session",
          createSchedulerRequest: false,
        };
      }
      // Middle исчерпал попытки, эскалация к senior.
      return {
        decision: "ESCALATE_ROLE",
        nextRoleLevel: "senior",
        reason: "Middle tier exhausted on task failure",
        createSchedulerRequest: true,
      };
    } else {
      // Уровень senior.
      if (attemptsAtLevel < policy.seniorAttempts) {
        return {
          decision: "RETRY",
          reason: "First task failure at senior tier - retry",
          createSchedulerRequest: true,
        };
      }
      // Senior исчерпал попытки.
      return {
        decision: "COORDINATOR_DIAGNOSIS",
        reason: "Senior tier exhausted on task failure",
        createSchedulerRequest: false,
      };
    }
  }

  // Назначение: block
  return {
    decision: "BLOCK",
    reason: "No recovery path available",
    createSchedulerRequest: false,
  };
}

/**
 * Calculates оставшиеся попытки at Объект указанного роль уровень.
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
