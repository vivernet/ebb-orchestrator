/**
 * Схема структурированного результата роли Reviewer.
 */

import { z } from "zod";
import { BaseOutputSchema, ReviewerOutcome } from "./common.js";

/** Схема результата Reviewer с признаком независимой проверки. */
export const ReviewerOutputSchema = BaseOutputSchema.extend({
  outcome: ReviewerOutcome,
  independent: z.literal(true).optional(),
});

/** Тип проверенного результата Reviewer. */
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
