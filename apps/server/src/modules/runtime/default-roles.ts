/**
 * Конфигурации ролей по умолчанию for Orchestrator Hermes.
 *
 * Основано на разделе спецификации 3.2 and 3.3.
 *
 * 9 roles in v1:
 * Управление / проектирование: Coordinator, Product Manager, Architect.
 * реализация: Middle Developer, Senior Developer, DevOps Agent
 * Quality / Integration: Reviewer, QОбъект Agent, Integration Agent
 *
 * Примечание: в этом плане выполняются только Developer/Reviewer/QA/Integration are executed.
 * - Reviewer must NOT have: workspace.patch, git.commit, command.shell
 * - Developer must NOT have: git.push, merge.default, permission/config mutation
 * - Session policy: fresh_per_task for Reviewer/QA/Integration; shared for Developer
 */

import { ActionId } from '../permissions/permission-types.js';
import type { RoleContract } from './role-contract.js';

/**
 * Все доступные инструменты системы.
 * Используется для построения allowlist инструментов ролей.
 */
export const AllTools: ActionId[] = [
  // Операции workspace
  ActionId.WorkspaceRead,
  ActionId.WorkspaceSearch,
  ActionId.WorkspacePatch,
  // Операции project
  ActionId.ProjectTest,
  ActionId.ProjectLint,
  ActionId.ProjectTypecheck,
  ActionId.ProjectBuild,
  // Выполнение команд
  ActionId.CommandExec,
  ActionId.CommandShell,
  // Операции Git
  ActionId.GitStatus,
  ActionId.GitDiff,
  ActionId.GitCommit,
  // Операции с artifacts
  ActionId.ArtifactWrite,
  ActionId.SubmitResult,
];

/**
 * Конфигурация модели по умолчанию for standard LLM backends.
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
 * Базовые пути к схемам in the contracts package.
 */
export const SchemaPaths = {
  base: '@ebb-orchestrator/contracts#BaseOutputSchema',
  coordinator: '@ebb-orchestrator/contracts#CoordinatorOutputSchema',
  productManager: '@ebb-orchestrator/contracts#ProductDefinitionSchema',
  architect: '@ebb-orchestrator/contracts#DesignResultSchema',
  devops: '@ebb-orchestrator/contracts#DevOpsOutputSchema',
  developer: '@ebb-orchestrator/contracts#DeveloperOutputSchema',
  reviewer: '@ebb-orchestrator/contracts#ReviewerOutputSchema',
  qa: '@ebb-orchestrator/contracts#QaOutputSchema',
  integration: '@ebb-orchestrator/contracts#IntegrationOutputSchema',
} as const;

/**
 * Общий путь к входной схеме for all roles.
 */
const DefaultInputSchema = {
  path: '@ebb-orchestrator/contracts#BaseOutputSchema',
  version: '1.0.0',
};

/**
 * Создаёт базовый RoleContract with common settings.
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
 * Конфигурация роли Coordinator.
 *
 * Раздел 3.3 спецификации:
 * "Coordinator классифицирует запрос, выбирает Task vs Epic, предлагает план,
 * зависимости, роли и workflow, выполняет replan и сложную диагностику.
 * Не редактирует production-код и не делает финальный merge."
 */
export const CoordinatorContract: RoleContract = {
  ...baseRole('coordinator', 'Coordinator'),
  purpose: 'Classifies requests, plans tasks/epics, manages dependencies, and performs complex diagnostics.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change', 'documentation', 'devops'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.coordinator, version: '1.0.0' },
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
 * Конфигурация роли Product Manager.
 *
 * Раздел 3.3 спецификации:
 * "Product Manager определяет goal, user behavior, scope, non-goals, requirements и acceptance criteria.
 * Не выбирает техническую реализацию."
 */
export const ProductManagerContract: RoleContract = {
  ...baseRole('product_manager', 'Product Manager'),
  purpose: 'Defines goals, user behavior, scope, requirements, and acceptance criteria without choosing technical implementation.',
  allowedWorkflows: ['standard', 'bugfix', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.productManager, version: '1.0.0' },
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
 * Конфигурация роли Architect.
 *
 * Раздел 3.3 спецификации:
 * "Architect определяет компоненты, interfaces, data flow, migrations, Decisions, guideline proposals и architecture review.
 * Обычно не реализует production-код."
 */
export const ArchitectContract: RoleContract = {
  ...baseRole('architect', 'Architect'),
  purpose: 'Defines components, interfaces, data flow, decisions, and performs architecture reviews.',
  allowedWorkflows: ['standard', 'bugfix', 'architecture_change', 'documentation'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.architect, version: '1.0.0' },
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
 * Конфигурация роли Middle Developer.
 *
 * Раздел 3.3 спецификации:
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
 * Конфигурация роли Senior Developer.
 *
 * Раздел 3.3 спецификации:
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
 * Конфигурация роли DevOps Agent.
 *
 * Раздел 3.3 спецификации:
 * "DevOps Agent отвечает за CI/CD, Docker, deployment/env/build/release/IaC.
 * Чувствительные publish/deploy действия проходят Permission Engine и approval."
 */
export const DevOpsContract: RoleContract = {
  ...baseRole('devops', 'DevOps Agent'),
  purpose: 'Handles CI/CD, Docker, deployment, environment, build, release, and infrastructure as code.',
  allowedWorkflows: ['devops'],
  inputSchema: DefaultInputSchema,
  outputSchema: { path: SchemaPaths.devops, version: '1.0.0' },
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
 * Конфигурация роли Reviewer.
 *
 * Раздел 3.3 спецификации:
 * "Reviewer независимо проверяет correctness, architecture, maintainability, security, edge cases, tests,
 * Guidelines, acceptance criteriОбъект и область creep. Обычно не исправляет собственные findings."
 *
 * SECURITY CONSTRAINT: Должен не have workspace.patch, git.commit, команда.shell
 * Политика сессия: fresh_per_task
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
    // Явно НЕ включено: workspace.patch, git.commit, команда.shell
  ],
  sessionPolicy: 'fresh_per_task',
  escalationPolicy: {
    trigger: 'on_failure',
    escalateTo: ['coordinator'],
  },
};

/**
 * Конфигурация роли QA Agent.
 *
 * Раздел 3.3 спецификации:
 * "QA Agent проверяет поведение, acceptance criteria, regression и edge cases.
 * Он создаёт defects, а не 'чинит по ходу'."
 *
 * Политика сессия: fresh_per_task
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
 * Конфигурация роли Integration Agent.
 *
 * Раздел 3.3 спецификации:
 * "Integration Agent подготавливает интеграцию с текущим target, разрешает только однозначные конфликты
 * и блокирует архитектурную неоднозначность. Не даёт себе финальное разрешение на merge."
 *
 * Политика сессия: fresh_per_task
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
    ActionId.ProjectTest,
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
 * Все role contracts, индексированные по имени роли.
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
 * Роли, выполняемые в этом плане.
 */
export const ExecutedRoles = ['developer', 'reviewer', 'qa', 'integration'] as const;

/**
 * Получает contract по имени роли (handles 'developer' alias for middle_dev/senior_dev).
 */
export function getContract(roleName: string): RoleContract | undefined {
  // Developer является Объект alias который cОбъект map to middle_dev или senior_dev
  if (roleName === 'developer') {
    return MiddleDevContract;
  }
  return AllContracts[roleName];
}

/**
 * Получает все contracts для выполняемых ролей.
 */
export function getExecutedContracts(): RoleContract[] {
  return ExecutedRoles.map(getContract).filter((c): c is RoleContract => c !== undefined);
}
