/**
 * Схема структурированного результата роли Integration.
 */

import { z } from "zod";
import { BaseOutputSchema, IntegrationOutcome } from "./common.js";

/** Схема результата Integration с provenance и evidence для проверки слияния. */
export const IntegrationOutputSchema = BaseOutputSchema.extend({
  outcome: IntegrationOutcome,
  baseSha: z.string().min(1).optional(),
  sourceSha: z.string().min(1).optional(),
  provenance: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.string().min(1)).optional(),
});

/** Тип результата Integration после проверки схемой. */
export type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;
