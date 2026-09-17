/**
 * RoleContract type definition for Orchestrator Hermes.
 *
 * Based on specification Section 3.2 - Role contracts define the complete
 * configuration for each AI role including tools, models, sessions, and permissions.
 */

import { z } from 'zod';
import type { ActionId } from '../permissions/permission-types.js';

// Session policy defines how Hermes sessions are managed per role
export const SessionPolicy = z.enum([
  'fresh_per_task',  // New session for each task
  'shared',           // Shared session across multiple tasks
  'task_lifetime',    // Session tied to single task lifecycle
]);

export type SessionPolicy = z.infer<typeof SessionPolicy>;

// Model reference for role-specific model selection
export interface ModelRef {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

// Output schema reference (path to schema in contracts package)
export interface OutputSchemaRef {
  /** Path to the output schema in the contracts package, e.g., '@ebb-orchestrator/contracts#DeveloperOutputSchema' */
  path: string;
  /** Schema version for backward compatibility */
  version: string;
}

// Input schema reference
export interface InputSchemaRef {
  path: string;
  version: string;
}

// Workflow types available to the role
export const WorkflowType = z.enum([
  'standard',
  'bugfix',
  'architecture_change',
  'documentation',
  'devops',
]);

export type WorkflowType = z.infer<typeof WorkflowType>;

// Permission profile defines access level for the role
export const PermissionProfile = z.enum([
  'restricted',   // Minimal permissions, read-only + controlled write
  'standard',     // Standard development permissions
  'elevated',     // Elevated permissions for integration/ops
  'admin',        // Full permissions (rarely used)
]);

export type PermissionProfile = z.infer<typeof PermissionProfile>;

// Escalation policy defines when/how to escalate issues
export interface EscalationPolicy {
  /** When to escalate - on first failure, after N attempts, etc. */
  trigger: 'on_failure' | 'after_attempts' | 'never';
  /** Number of attempts before escalation (if trigger is after_attempts) */
  maxAttempts?: number;
  /** Which role(s) to escalate to */
  escalateTo: string[];
}

/**
 * RoleContract defines the complete configuration for an AI role.
 *
 * Per specification Section 3.2:
 * "Роль — это не просто prompt. RoleContract содержит: purpose, allowed_workflows,
 * input_schema, output_schema, permission_profile, default_model, runtime,
 * allowed_tools, session_policy, escalation_policy"
 */
export interface RoleContract {
  /** Unique identifier for the role */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Description of the role's purpose and responsibilities */
  purpose: string;

  /** List of workflows this role is allowed to execute */
  allowedWorkflows: WorkflowType[];

  /** Input schema reference from contracts package */
  inputSchema: InputSchemaRef;

  /** Output schema reference from contracts package */
  outputSchema: OutputSchemaRef;

  /** Permission profile level */
  permissionProfile: PermissionProfile;

  /** Default model to use for this role */
  defaultModel: ModelRef;

  /** Runtime adapter to use (e.g., 'hermes', 'codex', 'opencode') */
  runtime: string;

  /** List of tool IDs this role is allowed to use */
  allowedTools: ActionId[];

  /** Session policy for this role */
  sessionPolicy: SessionPolicy;

  /** Escalation policy for this role */
  escalationPolicy?: EscalationPolicy;
}

// Role names matching specification Section 3.2
export const RoleNames = {
  COORDINATOR: 'coordinator' as const,
  PRODUCT_MANAGER: 'product_manager' as const,
  ARCHITECT: 'architect' as const,
  MIDDLE_DEV: 'middle_dev' as const,
  SENIOR_DEV: 'senior_dev' as const,
  DEVOPS: 'devops' as const,
  REVIEWER: 'reviewer' as const,
  QA: 'qa' as const,
  INTEGRATION: 'integration' as const,
} as const;

export type RoleName = typeof RoleNames[keyof typeof RoleNames];
