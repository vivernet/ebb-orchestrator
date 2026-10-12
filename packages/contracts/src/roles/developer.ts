/**
 * Схема структурированного результата роли Developer.
 */

import { z } from "zod";
import { BaseOutputSchema } from "./common.js";

/**
 * Схема структурированного результата роли Developer.
 * Успешное завершение обязано указывать commit реализации; заблокированная задача
 * может завершиться до создания commit.
 */
export const DeveloperOutputSchema = z.discriminatedUnion("outcome", [
  BaseOutputSchema.extend({
    outcome: z.literal("COMPLETED"),
    commitSha: z.string().min(1).regex(/\S/).describe("Exact commit SHA produced for the completed task"),
  }),
  BaseOutputSchema.extend({
    outcome: z.literal("BLOCKED"),
    commitSha: z.string().min(1).regex(/\S/).optional().describe("Commit SHA if the blocked task produced one"),
  }),
]);

/** Тип результата Developer после проверки схемой. */
export type DeveloperOutput = z.infer<typeof DeveloperOutputSchema>;
