/**
 * Default role configurations for Orchestrator Hermes.
 *
 * Based on specification Section 3.2 and 3.3.
 *
 * 9 roles in v1:
 * Management / Design: Coordinator, Product Manager, Architect
 * Implementation: Middle Developer, Senior Developer, DevOps Agent
 * Quality / Integration: Reviewer, QA Agent, Integration Agent
 *
 * Note: For this plan, only Developer/Reviewer/QA/Integration are executed.
 * - Reviewer must NOT have: workspace.patch, git.commit, command.shell
 * - Developer must NOT have: git.push, merge.default, permission/config mutation
 * - Session policy: fresh_per_task for Reviewer/QA/Integration; shared for Developer
 */

import { ActionId } from '../permissions/permission-types.js';
import type { RoleContract } from './role-contract.js';

/**
 * All available tools in the system.
 * Used to build role-specific tool allowlists.
 */
export const AllTools: ActionId[] = [
  // Workspace operations
  ActionId.WorkspaceRead,
  ActionId.WorkspaceSearch,
  ActionId.WorkspacePatch,
  // Project operations
  ActionId.ProjectTest,
  ActionId.ProjectLint,
  ActionId.ProjectTypecheck,
  ActionId.ProjectBuild,
  // Command execution
  ActionId.CommandExec,
  ActionId.CommandShell,
  // Git operations
  ActionId.GitStatus,
  ActionId.GitDiff,
  ActionId.GitCommit,
  // Artifact operations
  ActionId.ArtifactWrite,
  ActionId.SubmitResult,
];

/**
 * Default model configuration for standard LLM backends.
 */
export const DefaultModels = {
  fast: {
    provider: 'local',
    model: 'llama-3.1-8b',
    temperature: 0.7,
    maxTokens: 4096,
  },
  standard: {
    provider: 'local',
    model: 'llama-3.1-70b',
    temperature: 0.5,
    maxTokens: 8192,
  },
  strong: {
    provider: 'local',
    model: 'mistral-large',
    temperature: 0.4,
    maxTokens: 8192,
  },
} as const;

/**
 * Base schema paths in the contracts package.
 */
export const SchemaPaths = {
  base: '@orchestrator/contracts#BaseOutputSchema',
  developer: '@orchestrator/contracts#DeveloperOutputSchema',
  reviewer: '@orchestrator/contracts#ReviewerOutputSchema',
  qa: '@orchestrator/contracts#QaOutputSchema',
  integration: '@orchestrator/contracts#IntegrationOutputSchema',
} as const;

/**
 * Shared input schema path for all roles.
 */
const DefaultInputSchema = {
  path: '@orchestrator/contracts#BaseOutputSchema',
  version: '1.0.0',
};

/**
 * Creates a base RoleContract with common settings.
 */
function baseRole(name: string, displayName: string): Omit<RoleContract, 'allowedWorkflows' | 'inputSchema' | 'outputSchema' | 'permissionProfile' | 'defaultModel' | 'allowedTools' | 'sessionPolicy' | 'escalationPolicy'> {
  return {
    name,
    displayName,
    purpose: '',
    runtime: 'hermes',
  };
}

/**
 * Coordinator role configuration.
 *
 * Specification Section 3.3:
 * "Coordinator классифицирует запрос, выбирает Task vs Epic, предлагает план,
 * зависимости, роли и workflow, выполняет replan и сложную диагностику.
 * Не редактирует production-код и не делает финальный merge."
 */
export const CoordinatorContract: RoleContract = {
  ...baseRole('coordinator', 'Coordinator'),
  purpose: 'Classifies requests, plans tasks/epics, manages dependencies, and performs complex diagnostics.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change', 'documentation', 'devops'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.base, version: '1.0.0' },
  permissionProfile: 'standard',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.ProjectBuild,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'task_lifetime',
  escalationPolicy: {
    trigger: 'on_failure',
    escalateTo: ['architect', 'developer'],
  },
};

/**
 * Product Manager role configuration.
 *
 * Specification Section 3.3:
 * "Product Manager определяет goal, user behavior, scope, non-goals, requirements и acceptance criteria.
 * Не выбирает техническую реализацию."
 */
export const ProductManagerContract: RoleContract = {
  ...baseRole('product_manager', 'Product Manager'),
  purpose: 'Defines goals, user behavior, scope, requirements, and acceptance criteria without choosing technical implementation.',
  allowedWorkflows: ['standard', 'bugfix', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.base, version: '1.0.0' },
  permissionProfile: 'restricted',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'task_lifetime',
};

/**
 * Architect role configuration.
 *
 * Specification Section 3.3:
 * "Architect определяет компоненты, interfaces, data flow, migrations, Decisions, guideline proposals и architecture review.
 * Обычно не реализует production-код."
 */
export const ArchitectContract: RoleContract = {
  ...baseRole('architect', 'Architect'),
  purpose: 'Defines components, interfaces, data flow, decisions, and performs architecture reviews.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.base, version: '1.0.0' },
  permissionProfile: 'standard',
  defaultModel: DefaultModels.strong,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.WorkspacePatch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.ProjectBuild,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'shared',
  escalationPolicy: {
    trigger: 'on_failure',
    escalateTo: ['coordinator'],
  },
};

/**
 * Middle Developer role configuration.
 *
 * Specification Section 3.3:
 * "Middle Developer выполняет обычную реализацию."
 */
export const MiddleDevContract: RoleContract = {
  ...baseRole('middle_dev', 'Middle Developer'),
  purpose: 'Executes regular development tasks and implementation.',
  allowedWorkflows: ['standard', 'bugfix', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.developer, version: '1.0.0' },
  permissionProfile: 'standard',
  defaultModel: DefaultModels.fast,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.WorkspacePatch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.ProjectBuild,
    ActionId.CommandExec,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.GitCommit,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'shared',
};

/**
 * Senior Developer role configuration.
 *
 * Specification Section 3.3:
 * "Senior Developer выполняет сложную/core/architecture-sensitive реализацию и escalation после Middle."
 */
export const SeniorDevContract: RoleContract = {
  ...baseRole('senior_dev', 'Senior Developer'),
  purpose: 'Handles complex, core, and architecture-sensitive implementation tasks.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.developer, version: '1.0.0' },
  permissionProfile: 'standard',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.WorkspacePatch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.ProjectBuild,
    ActionId.CommandExec,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.GitCommit,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'shared',
};

/**
 * DevOps Agent role configuration.
 *
 * Specification Section 3.3:
 * "DevOps Agent отвечает за CI/CD, Docker, deployment/env/build/release/IaC.
 * Чувствительные publish/deploy действия проходят Permission Engine и approval."
 */
export const DevOpsContract: RoleContract = {
  ...baseRole('devops', 'DevOps Agent'),
  purpose: 'Handles CI/CD, Docker, deployment, environment, build, release, and infrastructure as code.',
  allowedWorkflows: ['devops'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.base, version: '1.0.0' },
  permissionProfile: 'elevated',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.WorkspacePatch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.ProjectBuild,
    ActionId.CommandExec,
    ActionId.CommandShell,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'task_lifetime',
};

/**
 * Reviewer role configuration.
 *
 * Specification Section 3.3:
 * "Reviewer независимо проверяет correctness, architecture, maintainability, security, edge cases, tests,
 * Guidelines, acceptance criteria и scope creep. Обычно не исправляет собственные findings."
 *
 * SECURITY CONSTRAINT: Must NOT have workspace.patch, git.commit, command.shell
 * SESSION POLICY: fresh_per_task
 */
export const ReviewerContract: RoleContract = {
  ...baseRole('reviewer', 'Reviewer'),
  purpose: 'Independently reviews code for correctness, architecture, maintainability, security, and acceptance criteria.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.reviewer, version: '1.0.0' },
  permissionProfile: 'restricted',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.ProjectTypecheck,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
    // Explicitly NOT included: workspace.patch, git.commit, command.shell
  ],
  sessionPolicy: 'fresh_per_task',
  escalationPolicy: {
    trigger: 'on_failure',
    escalateTo: ['coordinator'],
  },
};

/**
 * QA Agent role configuration.
 *
 * Specification Section 3.3:
 * "QA Agent проверяет поведение, acceptance criteria, regression и edge cases.
 * Он создаёт defects, а не 'чинит по ходу'."
 *
 * SESSION POLICY: fresh_per_task
 */
export const QAContract: RoleContract = {
  ...baseRole('qa', 'QA Agent'),
  purpose: 'Verifies behavior, acceptance criteria, regression, and edge cases. Creates defects without fixing them.',
  allowedWorkflows: ['standard', 'bugfix'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.qa, version: '1.0.0' },
  permissionProfile: 'restricted',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.ProjectTest,
    ActionId.ProjectLint,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'fresh_per_task',
};

/**
 * Integration Agent role configuration.
 *
 * Specification Section 3.3:
 * "Integration Agent подготавливает интеграцию с текущим target, разрешает только однозначные конфликты
 * и блокирует архитектурную неоднозначность. Не даёт себе финальное разрешение на merge."
 *
 * SESSION POLICY: fresh_per_task
 */
export const IntegrationContract: RoleContract = {
  ...baseRole('integration', 'Integration Agent'),
  purpose: 'Prepares integration with target branch, resolves trivial conflicts, and blocks architectural ambiguity.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.integration, version: '1.0.0' },
  permissionProfile: 'elevated',
  defaultModel: DefaultModels.standard,
  allowedTools: [
    ActionId.WorkspaceRead,
    ActionId.WorkspaceSearch,
    ActionId.GitStatus,
    ActionId.GitDiff,
    ActionId.ArtifactWrite,
    ActionId.SubmitResult,
  ],
  sessionPolicy: 'fresh_per_task',
  escalationPolicy: {
    trigger: 'on_failure',
    escalateTo: ['architect', 'coordinator'],
  },
};

/**
 * All role contracts indexed by role name.
 */
export const AllContracts: Record<string, RoleContract> = {
  coordinator: CoordinatorContract,
  product_manager: ProductManagerContract,
  architect: ArchitectContract,
  middle_dev: MiddleDevContract,
  senior_dev: SeniorDevContract,
  devops: DevOpsContract,
  reviewer: ReviewerContract,
  qa: QAContract,
  integration: IntegrationContract,
};

/**
 * Roles executed in this plan.
 */
export const ExecutedRoles = ['developer', 'reviewer', 'qa', 'integration'] as const;

/**
 * Gets a contract by role name (handles 'developer' alias for middle_dev/senior_dev).
 */
export function getContract(roleName: string): RoleContract | undefined {
  // Developer is an alias that can map to middle_dev or senior_dev
  if (roleName === 'developer') {
    return MiddleDevContract;
  }
  return AllContracts[roleName];
}

/**
 * Gets all contracts for executed roles.
 */
export function getExecutedContracts(): RoleContract[] {
  return ExecutedRoles.map(getContract).filter((c): c is RoleContract => c !== undefined);
}
