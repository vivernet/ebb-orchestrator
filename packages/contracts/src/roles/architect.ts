import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

/** Допустимые типы предложений Architect для последующей policy-проверки. */
export const ProposalType = z.enum([
  "NEW_TASK", "NEW_DEPENDENCY", "REMOVE_DEPENDENCY", "SCOPE_CHANGE",
  "REQUIREMENT_CHANGE", "ACCEPTANCE_CRITERIA_CHANGE", "GUIDELINE_CHANGE",
  "ARCHITECTURE_CHANGE", "ROLE_CHANGE", "WORKFLOW_CHANGE", "PLAN_CHANGE",
]);

/** Схема временного предложения, которое ещё не меняет domain state. */
export const ProposalCandidateSchema = z.object({
  type: ProposalType,
  title: z.string().min(1),
  rationale: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

/** Схема структурированного результата архитектурного проектирования. */
export const DesignResultSchema = BaseOutputSchema.extend({
  outcome: z.enum(["DESIGN", "BLOCKED"]),
  components: z.array(z.string().min(1)).optional(),
  interfaces: z.array(z.string().min(1)).optional(),
  dataFlow: z.array(z.string().min(1)).optional(),
  migrations: z.array(z.string().min(1)).optional(),
  decisions: z.array(z.string().min(1)).optional(),
  proposals: z.array(ProposalCandidateSchema).optional(),
  architectureReviewRequired: z.boolean().optional(),
}).strict();

/** Тип предложения Architect после проверки схемой. */
export type ProposalCandidate = z.infer<typeof ProposalCandidateSchema>;
/** Тип результата архитектурного проектирования после проверки схемой. */
export type DesignResult = z.infer<typeof DesignResultSchema>;
