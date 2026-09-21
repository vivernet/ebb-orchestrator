/**
 * Общие типы и базовая схема контрактов ролей.
 */

import { z } from "zod";

/** Базовая схема результата, общая для всех role contracts. */
export const BaseOutputSchema = z.object({
  version: z.string().describe("Schema version for backward compatibility"),
  summary: z.string().optional().describe("High-level summary of the outcome"),
  findings: z
    .array(
      z.object({
        type: z.enum(["INFO", "WARNING", "MINOR", "MAJOR", "BLOCKING"]).describe("Finding severity"),
        description: z.string().describe("Description of the finding"),
        file: z.string().optional().describe("File path if applicable"),
        line: z.number().optional().describe("Line number if applicable"),
      })
    )
    .optional()
    .describe("List of findings (optional)"),
}).strict();

/** Допустимые исходы Developer. */
export const DeveloperOutcome = z.enum(["COMPLETED", "BLOCKED"]);

/** Допустимые исходы Reviewer. */
export const ReviewerOutcome = z.enum(["PASS", "CHANGES_REQUESTED", "BLOCKED"]);

/** Допустимые исходы QA. */
export const QaOutcome = z.enum(["PASS", "FAIL", "BLOCKED"]);

/** Допустимые исходы Integration. */
export const IntegrationOutcome = z.enum(["PASS", "BLOCKED"]);

/** Общий тип результата после проверки базовой схемой. */
export type BaseOutput = z.infer<typeof BaseOutputSchema>;
/** Тип исхода Developer. */
export type DeveloperOutcome = z.infer<typeof DeveloperOutcome>;
/** Тип исхода Reviewer. */
export type ReviewerOutcome = z.infer<typeof ReviewerOutcome>;
/** Тип исхода QA. */
export type QaOutcome = z.infer<typeof QaOutcome>;
/** Тип исхода Integration. */
export type IntegrationOutcome = z.infer<typeof IntegrationOutcome>;

/** Общий структурированный результат любой роли до domain application. */
export interface RoleOutput {
  version: string;
  outcome: string;
  summary?: string;
  findings?: Array<{
    type: "INFO" | "WARNING" | "MINOR" | "MAJOR" | "BLOCKING";
    description: string;
    file?: string;
    line?: number;
  }>;
  failedCriteria?: Array<{
    id: string;
    required: boolean;
    description: string;
  }>;
  commitSha?: string;
  independent?: boolean;
  evidence?: string[];
  baseSha?: string;
  sourceSha?: string;
  provenance?: string[];
}

/** Результат schema validation перед применением результата к domain state. */
export interface ValidatedRoleOutput {
  valid: boolean;
  /** Значение после разбора схемой; присутствует только при `valid === true`. */
  output?: RoleOutput;
  outcome?: string;
  findings?: Array<{
    type: "INFO" | "WARNING" | "MINOR" | "MAJOR" | "BLOCKING";
    description: string;
    file?: string;
    line?: number;
  }>;
  failedCriteria?: Array<{
    id: string;
    required: boolean;
    description: string;
  }>;
  error?: string;
}
