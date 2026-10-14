/**
 * Схема структурированного результата роли Reviewer.
 */

import { z } from "zod";
import { BaseOutputSchema, QualityRecordUpdateSchema, ReviewerOutcome, uniqueQualityUpdates } from "./common.js";

/** Схема результата Reviewer с признаком независимой проверки. */
export const ReviewerOutputSchema = BaseOutputSchema.extend({
  outcome: ReviewerOutcome,
  independent: z.literal(true).optional(),
  finding_updates: z.array(QualityRecordUpdateSchema.extend({
    id: z.string().regex(/^FINDING-[1-9][0-9]*$/),
  })).optional().refine(uniqueQualityUpdates, "finding_updates must not contain duplicate IDs"),
}).strict();

/** Тип проверенного результата Reviewer. */
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
