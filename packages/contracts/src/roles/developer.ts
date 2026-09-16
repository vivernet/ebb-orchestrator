/**
 * Developer output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, DeveloperOutcome } from "./common.js";

export const DeveloperOutputSchema = BaseOutputSchema.extend({
  outcome: DeveloperOutcome,
  commitSha: z.string().min(1).optional(),
});

export type DeveloperOutput = z.infer<typeof DeveloperOutputSchema>;
