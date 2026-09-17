import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

export const ProposalType = z.enum([
  "NEW_TASK", "NEW_DEPENDENCY", "REMOVE_DEPENDENCY", "SCOPE_CHANGE",
  "REQUIREMENT_CHANGE", "ACCEPTANCE_CRITERIA_CHANGE", "GUIDELINE_CHANGE",
  "ARCHITECTURE_CHANGE", "ROLE_CHANGE", "WORKFLOW_CHANGE", "PLAN_CHANGE",
]);

export const ProposalCandidateSchema = z.object({
  type: ProposalType,
  title: z.string().min(1),
  rationale: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

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

export type ProposalCandidate = z.infer<typeof ProposalCandidateSchema>;
export type DesignResult = z.infer<typeof DesignResultSchema>;
