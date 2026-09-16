/**
 * Shared types and base schema for role contracts.
 */

import { z } from "zod";

// Base output schema that all roles extend
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

// Common outcome types for developers
export const DeveloperOutcome = z.enum(["COMPLETED", "BLOCKED"]);

// Common outcome types for reviewers
export const ReviewerOutcome = z.enum(["PASS", "CHANGES_REQUESTED", "BLOCKED"]);

// Common outcome types for QA
export const QaOutcome = z.enum(["PASS", "FAIL", "BLOCKED"]);

// Common outcome types for integration
export const IntegrationOutcome = z.enum(["PASS", "BLOCKED"]);

// Type exports
export type BaseOutput = z.infer<typeof BaseOutputSchema>;
export type DeveloperOutcome = z.infer<typeof DeveloperOutcome>;
export type ReviewerOutcome = z.infer<typeof ReviewerOutcome>;
export type QaOutcome = z.infer<typeof QaOutcome>;
export type IntegrationOutcome = z.infer<typeof IntegrationOutcome>;

// Common output structure
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
  provenance?: string[];
}

// Output validation result
export interface ValidatedRoleOutput {
  valid: boolean;
  /** The schema-parsed value. It is present only when valid is true. */
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
