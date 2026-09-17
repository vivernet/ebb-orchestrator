import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

export const CoordinatorOperation = z.enum([
  "CLASSIFY_REQUEST", "PLAN", "REPLAN", "DIAGNOSE", "ANALYZE_PROPOSAL",
]);
export const PlanningRole = z.enum([
  "coordinator", "product_manager", "architect", "middle_dev", "senior_dev",
  "developer", "devops", "reviewer", "qa", "integration",
]);
export const PlanningWorkflow = z.enum([
  "standard", "bugfix", "architecture_change", "documentation", "devops",
]);

export const TemporaryTaskSchema = z.object({
  ref: z.string().regex(/^task_[A-Za-z0-9_-]+$/),
  title: z.string().min(1),
  goal: z.string().min(1).optional(),
  context: z.string().optional(),
  requirements: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().regex(/^task_[A-Za-z0-9_-]+$/)).default([]),
  role: z.string().min(1),
  workflow: z.string().min(1),
  optional: z.boolean().default(false),
}).strict();

export const CoordinatorPlanSchema = z.object({
  tasks: z.array(TemporaryTaskSchema),
  epic: z.object({ title: z.string().min(1), goal: z.string().min(1).optional() }).optional(),
}).strict();

export const CoordinatorOutputSchema = BaseOutputSchema.extend({
  operation: CoordinatorOperation,
  classification: z.enum(["TASK", "EPIC", "NEEDS_INPUT"]).optional(),
  plan: CoordinatorPlanSchema.optional(),
  recommendedRoles: z.array(PlanningRole).optional(),
  recommendedWorkflow: PlanningWorkflow.optional(),
  diagnosis: z.string().min(1).optional(),
}).strict();

export type CoordinatorOutput = z.infer<typeof CoordinatorOutputSchema>;
export type TemporaryTask = z.infer<typeof TemporaryTaskSchema>;
