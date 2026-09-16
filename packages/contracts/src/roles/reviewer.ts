/**
 * Reviewer output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, ReviewerOutcome } from "./common.js";

export const ReviewerOutputSchema = BaseOutputSchema.extend({
  outcome: ReviewerOutcome,
  independent: z.literal(true).optional(),
});

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;
