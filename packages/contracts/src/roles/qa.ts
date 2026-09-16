/**
 * QA output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, QaOutcome } from "./common.js";

export const QaOutputSchema = BaseOutputSchema.extend({
  outcome: QaOutcome,
  evidence: z.array(z.string().min(1)).optional(),
  failedCriteria: z
    .array(
      z.object({
        id: z.string().describe("Acceptance criterion identifier"),
        required: z.boolean().describe("Whether this criterion is required"),
        description: z.string().describe("Description of the criterion"),
      })
    )
    .optional()
    .describe("List of failed criteria"),
});

export type QaOutput = z.infer<typeof QaOutputSchema>;
