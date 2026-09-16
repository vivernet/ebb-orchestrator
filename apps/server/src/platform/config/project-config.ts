/**
 * Versioned project configuration schema.
 *
 * Uses Zod strict objects so that unknown fields are rejected at parse time
 * (see design spec §20 — unknown fields in versioned config are validation errors).
 */

import { z } from "zod";
import { ConfigValidationError } from "./config-errors.js";

export const ProjectConfigV1Schema = z.strictObject({
  schema_version: z.literal(1),
  project: z.strictObject({
    name: z.string().min(1),
    default_branch: z.string().min(1),
  }),
  execution: z
    .strictObject({
      mode: z.literal("local").default("local"),
    })
    .default({ mode: "local" }),
});

export type ProjectConfigV1 = z.infer<typeof ProjectConfigV1Schema>;

/**
 * Parse and validate raw input as a ProjectConfigV1.
 *
 * @throws {ConfigValidationError} if the input does not match the schema.
 */
export function parseProjectConfig(input: unknown): ProjectConfigV1 {
  const result = ProjectConfigV1Schema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(
      `Project config validation failed: ${result.error.message}`,
      result.error.issues,
    );
  }
  return result.data;
}
