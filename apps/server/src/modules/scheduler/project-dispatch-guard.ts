import type { DatabaseTx } from "../../platform/database/database.js";
import { projectConfigDispatchAllowedTx } from "../projects/project-config-service.js";

export type ProjectDispatchEligibility =
  | { allowed: true }
  | { allowed: false; reason: "PROJECT_NOT_ACTIVE" | "ONBOARDING_NOT_ACTIVE" | "PROJECT_CONFIG_DEGRADED" };
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
  if (!projectConfigDispatchAllowedTx(tx, projectId)) return { allowed: false, reason: "PROJECT_CONFIG_DEGRADED" };
  return { allowed: true };
}

/** Бросает machine-readable error, если проект нельзя dispatch/reserve. */
export function assertProjectDispatchableTx(tx: DatabaseTx, projectId: string): void {
  const result = projectDispatchEligibilityTx(tx, projectId);
  if (!result.allowed) throw new Error(result.reason);
}

/**
 * Результат проверки durable dispatch-паузы (plan-27 Task 2).
 * Пауза блокирует только НОВЫЕ reservation; текущие Run не отменяются.
 */
export type DispatchPauseEligibility =
  | { allowed: true }
  | { allowed: false; reason: "DISPATCH_PAUSED_GLOBAL" | "DISPATCH_PAUSED_PROJECT" | "DISPATCH_PAUSED_EPIC" };

/**
 * Проверяет глобальную паузу диспетчеризации и ancestor scope-паузы
 * (PROJECT задачи, EPIC задачи) в caller-owned транзакции. Проверка
 * выполняется внутри той же транзакции admission/reservation, чтобы
 * закоммиченная пауза гарантированно исключала новую reservation.
 */
export function dispatchPauseEligibilityTx(tx: DatabaseTx, scope: { projectId?: string; epicId?: string | null }): DispatchPauseEligibility {
  // Совместимость с историческими схемами до 053: без колонки dispatch_paused
  // глобальная пауза отсутствует (fail-open только в pre-053-каталоге).
  const hasPauseColumn = tx.all<{ name: string }>("PRAGMA table_info(scheduler_config)").some((column) => column.name === "dispatch_paused");
  const config = hasPauseColumn ? tx.get<{ dispatch_paused: number }>("SELECT dispatch_paused FROM scheduler_config WHERE id=1") : undefined;
  if (config?.dispatch_paused === 1) return { allowed: false, reason: "DISPATCH_PAUSED_GLOBAL" };
  const hasScopePauses = tx.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_scope_pauses'",
  );
  if (hasScopePauses) {
    if (scope.projectId !== undefined && tx.get("SELECT 1 FROM scheduler_scope_pauses WHERE scope='PROJECT' AND scope_id=$id", { id: scope.projectId })) {
      return { allowed: false, reason: "DISPATCH_PAUSED_PROJECT" };
    }
    if (scope.epicId != null && tx.get("SELECT 1 FROM scheduler_scope_pauses WHERE scope='EPIC' AND scope_id=$id", { id: scope.epicId })) {
      // Эпик-пауза блокирует только descendants этого же проекта: чужой
      // эпик-пауза не должна протекать между проектами.
      const bindsToSameProject = scope.projectId === undefined
        || tx.get("SELECT 1 FROM epics WHERE id=$epic AND project_id=$project", { epic: scope.epicId, project: scope.projectId });
      if (bindsToSameProject) return { allowed: false, reason: "DISPATCH_PAUSED_EPIC" };
    }
  }
  return { allowed: true };
}

/** Бросает machine-readable error, если новая reservation запрещена паузой. */
export function assertDispatchPauseAllowedTx(tx: DatabaseTx, scope: { projectId?: string; epicId?: string | null }): void {
  const result = dispatchPauseEligibilityTx(tx, scope);
  if (!result.allowed) throw new Error(result.reason);
}
