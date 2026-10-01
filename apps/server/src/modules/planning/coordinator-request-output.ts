import { CoordinatorOutputSchema } from "@ebb-orchestrator/contracts";
import { validateRoleOutput } from "../runtime/output-validator.js";
import { validatePlan } from "./plan-validator.js";
import type { PlanningPlanInput } from "./planning-types.js";

export type CoordinatorRequestDecision =
  | { classification: "NEEDS_INPUT" }
  | { classification: "TASK" | "EPIC"; plan: PlanningPlanInput };

/** Преобразует недоверенный результат Coordinator в проверенное доменное решение. */
export function parseCoordinatorRequestOutput(value: unknown, projectId: string, requestedBy: string): CoordinatorRequestDecision {
  const validated = validateRoleOutput("coordinator", value);
  if (!validated.valid || !validated.output) throw new Error("Coordinator output failed validation");
  const output = CoordinatorOutputSchema.parse(validated.output);
  if (output.classification === "NEEDS_INPUT") {
    if (output.operation !== "CLASSIFY_REQUEST" || output.plan !== undefined) throw new Error("Coordinator NEEDS_INPUT output is incoherent");
    return { classification: "NEEDS_INPUT" };
  }
  if (output.operation !== "PLAN" || !output.plan || !output.classification) throw new Error("Coordinator plan output is incomplete");
  if (output.classification === "EPIC" && (!output.plan.epic || output.plan.tasks.length < 2)) throw new Error("Epic classification requires a multi-task Epic plan");
  if (output.classification === "TASK" && (output.plan.epic || output.plan.tasks.length !== 1)) throw new Error("Task classification requires one standalone Task");
  const plan: PlanningPlanInput = { projectId, requestedBy, tasks: output.plan.tasks.map((task) => ({
    ref: task.ref, title: task.title, acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: task.dependsOn, role: task.role, workflow: task.workflow, optional: task.optional,
    ...(task.goal !== undefined ? { goal: task.goal } : {}),
    ...(task.context !== undefined ? { context: task.context } : {}),
    ...(task.requirements !== undefined ? { requirements: task.requirements } : {}),
  })) };
  if (output.plan.epic) plan.epic = { title: output.plan.epic.title, ...(output.plan.epic.goal !== undefined ? { goal: output.plan.epic.goal } : {}) };
  validatePlan(plan);
  return { classification: output.classification, plan };
}
