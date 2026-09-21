/**
 * RoleContract тип definition для Orchestrator Hermes.
 *
 * Основано на разделе спецификации 3.2 - Role contracts define the complete
 * конфигурация для каждого AI роль including инструменты, модели, sessions, и permissions.
 */

import { z } from 'zod';
import type { ActionId } from '../permissions/permission-types.js';

// Политика сессия defines how Hermes sessions являются managed per роль
export const SessionPolicy = z.enum([
  'fresh_per_task',  // New session for each task
  'shared',           // Shared session across multiple tasks
  'task_lifetime',    // Session tied to single task lifecycle
]);

export type SessionPolicy = z.infer<typeof SessionPolicy>;

// модель reference для role-specific модель selection
export interface ModelRef {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

// результат schemОбъект reference (путь to schemОбъект in contracts package)
export interface OutputSchemaRef {
  /** путь to Объект результат schemОбъект in Объект contracts package, e.g., '@ebb-orchestrator/contracts#DeveloperOutputSchema' */
  path: string;
  /** SchemОбъект версия для обратной совместимости */
  version: string;
}

// вход schemОбъект reference
export interface InputSchemaRef {
  path: string;
  version: string;
}

// workflow типы доступный to Объект роль
export const WorkflowType = z.enum([
  'standard',
  'bugfix',
  'architecture_change',
  'documentation',
  'devops',
]);

export type WorkflowType = z.infer<typeof WorkflowType>;

// Типы решений Permission profile defines access level for the role
export const PermissionProfile = z.enum([
  'restricted',   // Minimal permissions, read-only + controlled write
  'standard',     // Standard development permissions
  'elevated',     // Elevated permissions for integration/ops
  'admin',        // Full permissions (rarely used)
]);

export type PermissionProfile = z.infer<typeof PermissionProfile>;

// Политика эскалации defines когда/how to escalate issues
export interface EscalationPolicy {
  /** Когда to escalate - on first failure, after N attempts, etc. */
  trigger: 'on_failure' | 'after_attempts' | 'never';
  /** Количество попыток перед escalation (если trigger является after_attempts) */
  maxAttempts?: number;
  /** Which роль(s) to escalate to */
  escalateTo: string[];
}

/**
 * RoleContract defines Объект complete конфигурация для Объект AI роль.
 *
 * Согласно разделу 3.2 спецификации:
 * "Роль — это не просто prompt. RoleContract содержит: purpose, allowed_workflows,
 * Поля контракта: input_schema, output_schema, permission_profile, default_model, runtime,
 * Разрешённые инструменты, политика сессии и политика эскалации: allowed_tools, session_policy, escalation_policy.
 */
export interface RoleContract {
  /** Уникальный идентификатор для Объект роль */
  name: string;

  /** Отображаемое имя, предназначенное для человека. */
  displayName: string;

  /** описание of Объект роль's назначение и обязанности */
  purpose: string;

  /** Список workflow этот роль разрешён to execute */
  allowedWorkflows: WorkflowType[];

  /** вход schemОбъект reference из contracts package */
  inputSchema: InputSchemaRef;

  /** результат schemОбъект reference из contracts package */
  outputSchema: OutputSchemaRef;

  /** Типы решений Permission profile level */
  permissionProfile: PermissionProfile;

  /** Назначение model to use for this role */
  defaultModel: ModelRef;

  /** Используемый runtime adapter (e.g., 'hermes', 'codex', 'opencode') */
  runtime: string;

  /** Список ID инструментов этот роль разрешён to использовать */
  allowedTools: ActionId[];

  /** Политика сессия для этот роль */
  sessionPolicy: SessionPolicy;

  /** Политика эскалации для этот роль */
  escalationPolicy?: EscalationPolicy;
}

// роль names соответствующий specification Section 3.2
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
