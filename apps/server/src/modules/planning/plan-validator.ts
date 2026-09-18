import type { PlanValidationResult, PlanningPlanInput, TemporaryTask } from "./planning-types.js";
import type { TaskContract } from "../work/work-types.js";

const roles = new Set(["coordinator", "product_manager", "architect", "middle_dev", "senior_dev", "developer", "devops", "reviewer", "qa", "integration"]);
const workflows = new Set(["standard", "bugfix", "architecture_change", "documentation", "devops"]);

/**
 * Предоставляет публичный контракт модуля plan-validator для взаимодействия слоёв приложения.
 */
export function validatePlan(plan: PlanningPlanInput): PlanValidationResult {
  if (!plan.projectId) throw new Error("Plan projectId is required");
  const refs = new Set<string>();
  const contracts = new Map<string, TaskContract>();
  for (const task of plan.tasks) {
    if (!/^task_[A-Za-z0-9_-]+$/.test(task.ref)) throw new Error(`Invalid temporary task ref ${task.ref}`);
    if (refs.has(task.ref)) throw new Error(`Duplicate task ref ${task.ref}`);
    refs.add(task.ref);
    if (!roles.has(task.role)) throw new Error(`Unknown planning role ${task.role}`);
    if (!workflows.has(task.workflow)) throw new Error(`Unknown workflow ${task.workflow}`);
    if (!task.acceptanceCriteria?.length) throw new Error(`Task ${task.ref} requires acceptance criteria`);
    contracts.set(task.ref, toContract(task));
  }
  const edges = new Map<string, string[]>();
  for (const task of plan.tasks) {
    const deps = task.dependsOn ?? [];
    for (const dependency of deps) {
      if (!refs.has(dependency)) throw new Error(`Task ${task.ref} depends on unknown ref ${dependency}`);
    }
    edges.set(task.ref, deps);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ref: string): void => {
    if (visiting.has(ref)) throw new Error("Cyclic temporary dependency graph");
    if (visited.has(ref)) return;
    visiting.add(ref);
    for (const dependency of edges.get(ref) ?? []) visit(dependency);
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const ref of refs) visit(ref);
  return { contracts };
}

function toContract(task: TemporaryTask): TaskContract {
  return {
    version: 1,
    goal: task.goal ?? task.title,
    context: task.context ?? "",
    requirements: task.requirements ?? [],
    acceptanceCriteria: task.acceptanceCriteria,
    dependencies: task.dependsOn ?? [],
    nonGoals: [],
    definitionOfDone: task.acceptanceCriteria,
  };
}
