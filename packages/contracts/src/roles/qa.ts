/**
 * Схема структурированного результата роли QA.
 */

import { z } from "zod";
import { BaseOutputSchema, QualityRecordUpdateSchema, QaOutcome, uniqueQualityUpdates } from "./common.js";

/** Схема результата QA с evidence и обязательными failed criteria. */
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
    .describe("List of failed criteria")
    .refine((items) => items === undefined || new Set(items.map(({ id }) => id)).size === items.length, "failedCriteria must not repeat criterion IDs"),
  defect_updates: z.array(QualityRecordUpdateSchema.extend({
    id: z.string().regex(/^DEFECT-[1-9][0-9]*$/),
  })).optional().refine(uniqueQualityUpdates, "defect_updates must not contain duplicate IDs"),
}).strict();

/** Тип проверенного результата QA. */
export type QaOutput = z.infer<typeof QaOutputSchema>;
