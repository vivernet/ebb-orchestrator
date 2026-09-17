/**
 * Output validator for role outputs.
 * Performs schema validation and semantic invariants checks.
 */

import { z } from "zod";
import {
  type ValidatedRoleOutput,
  type RoleOutput,
  DeveloperOutputSchema,
  ReviewerOutputSchema,
  QaOutputSchema,
  IntegrationOutputSchema,
} from "@ebb-orchestrator/contracts";

export type { RoleOutput, ValidatedRoleOutput };

const schemas: Record<string, z.ZodSchema> = {
  developer: DeveloperOutputSchema,
  reviewer: ReviewerOutputSchema,
  qa: QaOutputSchema,
  integration: IntegrationOutputSchema,
};

/**
 * Validates role output against schema and semantic rules.
 * @param role - The role name (developer, reviewer, qa, integration)
 * @param value - The raw output from the model
 * @returns ValidatedRoleOutput with validation result
 */
export function validateRoleOutput(role: string, value: unknown): ValidatedRoleOutput {
  const schema = schemas[role];
  
  if (!schema) {
    return {
      valid: false,
      error: `Unknown role: ${role}`,
    };
  }

  // First pass: schema validation
  const schemaResult = schema.safeParse(value);
  if (!schemaResult.success) {
    const errors = schemaResult.error.issues.map((e) => e.message).join("; ");
    return {
      valid: false,
      error: `Schema validation failed: ${errors}`,
    };
  }

  const data = schemaResult.data as RoleOutput;
  const findings = data.findings ?? [];
  const failedCriteria = data.failedCriteria ?? [];

  // Semantic validation based on outcome
  const outcome = data.outcome;

  // Reviewer semantic rules
  if (role === "reviewer") {
    if (outcome === "PASS") {
      const blockingFindings = findings.filter((f) => f.type === "BLOCKING");
      if (blockingFindings.length > 0) {
        return {
          valid: false,
          outcome,
          findings,
          error: "PASS outcome cannot have blocking findings",
        };
      }
    }
  }

  // QA semantic rules
  if (role === "qa") {
    if (outcome === "PASS") {
      const requiredFailed = failedCriteria.filter((c) => c.required);
      if (requiredFailed.length > 0) {
        return {
          valid: false,
          outcome,
          failedCriteria,
          error: "PASS outcome cannot have failed required criteria",
        };
      }
    }
  }

  // All validations passed
    return {
      valid: true,
      output: data,
      outcome,
    findings,
    failedCriteria,
  };
}
