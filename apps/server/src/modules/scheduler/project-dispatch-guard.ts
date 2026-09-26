import type { DatabaseTx } from "../../platform/database/database.js";

export type ProjectDispatchEligibility =
  | { allowed: true }
  | { allowed: false; reason: "PROJECT_NOT_ACTIVE" | "ONBOARDING_NOT_ACTIVE" };

/**
 * Проверяет авторитетное состояние проекта и onboarding в одной caller-owned
 * транзакции. Отсутствующая строка onboarding считается жёсткой блокировкой.
 */
export function projectDispatchEligibilityTx(tx: DatabaseTx, projectId: string): ProjectDispatchEligibility {
  const project = tx.get<{ status: string }>("SELECT status FROM projects WHERE id=$projectId", { projectId });
  if (!project || project.status !== "ACTIVE") return { allowed: false, reason: "PROJECT_NOT_ACTIVE" };
  // Onboarding is a mandatory dispatch boundary; a missing table is not an implicit bypass.
  const hasOnboardingTable = tx.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_configs'");
  if (!hasOnboardingTable) return { allowed: false, reason: "ONBOARDING_NOT_ACTIVE" };
  const onboarding = tx.get<{ status: string }>(
    `SELECT oc.status FROM onboarding_configs oc
       JOIN approvals a ON a.id=oc.approval_id
      WHERE oc.project_id=$projectId AND oc.status='ACTIVE'
        AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
        AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
    { projectId },
  );
  if (!onboarding || onboarding.status !== "ACTIVE") return { allowed: false, reason: "ONBOARDING_NOT_ACTIVE" };
  return { allowed: true };
}

/** Бросает machine-readable error, если проект нельзя dispatch/reserve. */
export function assertProjectDispatchableTx(tx: DatabaseTx, projectId: string): void {
  const result = projectDispatchEligibilityTx(tx, projectId);
  if (!result.allowed) throw new Error(result.reason);
}
