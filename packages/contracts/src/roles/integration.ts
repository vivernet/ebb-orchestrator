/**
 * Схема структурированного результата роли Integration.
 */

import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

const BlockedIntegrationOutputSchema = BaseOutputSchema.extend({
  outcome: z.literal("BLOCKED"),
  baseSha: z.string().min(1).optional(),
  sourceSha: z.string().min(1).optional(),
  provenance: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.string().min(1)).optional(),
});

/** PASS обязан связывать проверенные SHA и evidence с точной Integration attempt. */
const PassedIntegrationOutputSchema = BaseOutputSchema.extend({
  outcome: z.literal("PASS"),
  baseSha: z.string().min(1),
  sourceSha: z.string().min(1),
  provenance: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

/** Схема результата Integration: BLOCKED описывает отказ, PASS требует SHA и evidence. */
export const IntegrationOutputSchema = z.discriminatedUnion("outcome", [
  PassedIntegrationOutputSchema,
  BlockedIntegrationOutputSchema,
]);

/** Тип результата Integration после проверки схемой. */
export type IntegrationOutput = z.infer<typeof IntegrationOutputSchema>;
