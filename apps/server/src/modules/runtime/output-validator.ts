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
  CoordinatorOutputSchema,
  ProductDefinitionSchema,
  DesignResultSchema,
  DevOpsOutputSchema,
  type CoordinatorOutput,
} from "@ebb-orchestrator/contracts";

export type { RoleOutput, ValidatedRoleOutput };

const schemas: Record<string, z.ZodSchema> = {
  developer: DeveloperOutputSchema,
  middle_dev: DeveloperOutputSchema,
  senior_dev: DeveloperOutputSchema,
  reviewer: ReviewerOutputSchema,
  qa: QaOutputSchema,
  integration: IntegrationOutputSchema,
  coordinator: CoordinatorOutputSchema,
  product_manager: ProductDefinitionSchema,
  "product-manager": ProductDefinitionSchema,
  architect: DesignResultSchema,
  devops: DevOpsOutputSchema,
};

const roles = new Set(["coordinator", "product_manager", "product-manager", "architect", "middle_dev", "senior_dev", "developer", "devops", "reviewer", "qa", "integration"]);
const workflows = new Set(["standard", "bugfix", "architecture_change", "documentation", "devops"]);

function validateCoordinatorPlan(value: CoordinatorOutput): string | undefined {
  if (!value.plan) return undefined;
  const refs = new Set<string>();
  for (const task of value.plan.tasks) {
    if (refs.has(task.ref)) return `Duplicate temporary task ref: ${task.ref}`;
    refs.add(task.ref);
    if (!roles.has(task.role)) return `Unknown role: ${task.role}`;
    if (!workflows.has(task.workflow)) return `Unknown workflow: ${task.workflow}`;
    if (task.acceptanceCriteria.length === 0) return `Task ${task.ref} must have acceptance criteria`;
  }
  for (const task of value.plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!refs.has(dependency)) return `Unknown dependency ref: ${dependency}`;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byRef = new Map(value.plan.tasks.map((task) => [task.ref, task]));
  const visit = (ref: string): boolean => {
    if (visiting.has(ref)) return true;
    if (visited.has(ref)) return false;
    visiting.add(ref);
    for (const dependency of byRef.get(ref)?.dependsOn ?? []) if (visit(dependency)) return true;
    visiting.delete(ref);
    visited.add(ref);
    return false;
  };
  if ([...refs].some(visit)) return "Cycle detected in temporary dependency graph";
  return undefined;
}

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

  if (role === "coordinator") {
    const planError = validateCoordinatorPlan(data as unknown as CoordinatorOutput);
    if (planError) return { valid: false, outcome, findings, error: planError };
  }

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
