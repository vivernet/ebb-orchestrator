/**
 * Developer output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, DeveloperOutcome } from "./common.js";

export const DeveloperOutputSchema = BaseOutputSchema.extend({
  outcome: DeveloperOutcome,
});

export type DeveloperOutput = z.infer<typeof DeveloperOutputSchema>;
