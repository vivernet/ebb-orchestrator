import type { PlanningApprovalPolicy, PlanningPlanInput } from "./planning-types.js";

export const DEFAULT_PLANNING_APPROVAL_POLICY: PlanningApprovalPolicy = {
  standalone_task: false,
  multi_task_plan: true,
  epic: true,
  architecture_change: true,
};

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export function effectivePlanningApprovalPolicy(
  overrides: Partial<PlanningApprovalPolicy> = {},
): PlanningApprovalPolicy {
  return { ...DEFAULT_PLANNING_APPROVAL_POLICY, ...overrides };
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export function planningApprovalRequired(
  plan: Pick<PlanningPlanInput, "tasks" | "epic" | "architectureChange">,
  policy: Partial<PlanningApprovalPolicy> = {},
): boolean {
  const effective = effectivePlanningApprovalPolicy(policy);
  if (plan.architectureChange && effective.architecture_change) return true;
  if (plan.epic && effective.epic) return true;
  if (plan.tasks.length > 1 && effective.multi_task_plan) return true;
  return plan.tasks.length === 1 && effective.standalone_task;
}
