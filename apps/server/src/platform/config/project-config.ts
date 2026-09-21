/**
 * Версионируемая схема конфигурации проекта.
 *
 * Использует строгие объекты Zod, поэтому неизвестные поля отклоняются при разборе
 * (см. design spec §20: неизвестные поля версионируемой конфигурации являются ошибками валидации).
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
 * Разбирает и валидирует исходные данные как ProjectConfigV1.
 *
 * @throws {ConfigValidationError} Если входные данные не соответствуют схеме.
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
