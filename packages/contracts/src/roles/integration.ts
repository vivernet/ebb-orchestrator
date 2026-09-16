/**
 * Integration output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, IntegrationOutcome } from "./common.js";

export const IntegrationOutputSchema = BaseOutputSchema.extend({
  outcome: IntegrationOutcome,
  baseSha: z.string().min(1).optional(),
  sourceSha: z.string().min(1).optional(),
  provenance: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.string().min(1)).optional(),
});

export type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;
