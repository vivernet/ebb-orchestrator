/**
 * Integration output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, IntegrationOutcome } from "./common.js";

export const IntegrationOutputSchema = BaseOutputSchema.extend({
  outcome: IntegrationOutcome,
});

export type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;
