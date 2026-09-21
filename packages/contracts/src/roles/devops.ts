import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

/** Схема результата DevOps с отделённым списком запрошенных операций. */
export const DevOpsOutputSchema = BaseOutputSchema.extend({
  outcome: z.enum(["COMPLETED", "BLOCKED"]),
  requestedOperations: z.array(z.string().min(1)).default([]),
  changedFiles: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.string().min(1)).optional(),
}).strict();

/** Тип результата DevOps после проверки схемой. */
export type DevOpsOutput = z.infer<typeof DevOpsOutputSchema>;
