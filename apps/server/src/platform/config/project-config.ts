/**
 * Версионируемая схема конфигурации проекта.
 *
 * Использует строгие объекты Zod, поэтому неизвестные поля отклоняются при разборе
 * (см. design spec §20: неизвестные поля версионируемой конфигурации являются ошибками валидации).
 */

import { z } from "zod";
import { load } from "js-yaml";
import { ConfigValidationError } from "./config-errors.js";
import { isDisallowedProjectCommandExecutable } from "../process/project-command-policy.js";

const MAX_PROJECT_COMMAND_EXECUTABLE_LENGTH = 4096;
const MAX_PROJECT_COMMAND_ARGUMENT_COUNT = 256;
const MAX_PROJECT_COMMAND_ARGUMENT_LENGTH = 8192;

const ProjectCommandV1Schema = z.strictObject({
  executable: z.string().min(1).max(MAX_PROJECT_COMMAND_EXECUTABLE_LENGTH)
    .refine((value) => !value.includes("\0"), "must not contain NUL")
    .refine((value) => !isDisallowedProjectCommandExecutable(value), "known shell interpreters or launchers are not allowed"),
  args: z.array(z.string().max(MAX_PROJECT_COMMAND_ARGUMENT_LENGTH)
    .refine((value) => !value.includes("\0"), "must not contain NUL")).max(MAX_PROJECT_COMMAND_ARGUMENT_COUNT),
});

const ProjectCommandsV1Schema = z.strictObject({
  test: ProjectCommandV1Schema.optional(),
  lint: ProjectCommandV1Schema.optional(),
  typecheck: ProjectCommandV1Schema.optional(),
  build: ProjectCommandV1Schema.optional(),
});

export const ProjectConfigV1Schema = z.strictObject({
  schema_version: z.literal(1),
  project: z.strictObject({
    name: z.string().min(1),
    default_branch: z.string().min(1),
  }),
  execution: z
    .strictObject({
      mode: z.literal("local").default("local"),
      commands: ProjectCommandsV1Schema.optional(),
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

/** Разбирает строгий YAML project.yaml и применяет ту же versioned schema authority. */
export function parseProjectConfigYaml(source: string): ProjectConfigV1 {
  let input: unknown;
  try {
    input = load(source, { json: false });
  } catch (cause) {
    throw new ConfigValidationError(
      `Project config YAML parsing failed: ${cause instanceof Error ? cause.message : "invalid YAML"}`,
      [],
    );
  }
  return parseProjectConfig(input);
}
