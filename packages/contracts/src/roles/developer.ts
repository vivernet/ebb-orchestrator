/**
 * Developer output schema.
 */

import { z } from "zod";
import { BaseOutputSchema, DeveloperOutcome } from "./common.js";

/** Схема структурированного результата роли Developer. */
export const DeveloperOutputSchema = BaseOutputSchema.extend({
  outcome: DeveloperOutcome,
  commitSha: z.string().min(1).optional(),
});

/** Тип результата Developer после проверки схемой. */
export type DeveloperOutput = z.infer<typeof DeveloperOutputSchema>;
