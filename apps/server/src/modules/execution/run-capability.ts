/**
 * RunCapability defines the security boundary for an agent run.
 * It binds a run to a specific role, workspace, and permitted tools.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import { ActionGateway } from './action-gateway.js';
import { GitTools } from './git-tools.js';
import { WorkspaceTools } from './workspace-tools.js';
import type { ProjectConfig } from './project-actions.js';

export type RoleName = 'developer' | 'reviewer' | 'qa' | 'integration' | 'coordinator' | 'architect';
export type ToolId =
  | 'workspace.read'
  | 'workspace.search'
  | 'workspace.patch'
  | 'git.status'
  | 'git.diff'
  | 'git.commit'
  | 'project.test'
  | 'submit_result';

export interface RunCapabilityDef {
  id: string;
  /** Opaque reference issued by the orchestrator for exactly one run. */
  capabilityRef?: string;
  runId?: string;
  role: RoleName;
  workspace: string;
  allowedTools: ToolId[];
  projectConfig?: ProjectConfig;
}

/**
 * Предоставляет execution-контракт run-capability с проверкой capability перед побочным эффектом.
 */
export class RunCapability {
  private resolver: PathResolver;
  private gateway: ActionGateway;
  private workspaceTools: WorkspaceTools;
  private gitTools: GitTools | null;

  constructor(public capability: RunCapabilityDef, private readonly revalidate?: () => void) {
    this.resolver = new PathResolver();
    this.gateway = new ActionGateway(this.resolver, capability.workspace, capability.allowedTools, capability.projectConfig);
    this.workspaceTools = new WorkspaceTools(this.resolver, capability.workspace);
    this.gitTools = capability.workspace ? new GitTools(capability.workspace) : null;
  }

  /** Создаёт a reference; the caller supplies the already-authorized binding. */
  static issue(def: Omit<RunCapabilityDef, 'id' | 'capabilityRef'> & { runId: string }): RunCapability {
    const ref = crypto.randomUUID();
    return new RunCapability({ ...def, id: ref, capabilityRef: ref });
  }

  get runId(): string { return this.capability.runId ?? this.capability.id; }

  get reference(): string { return this.capability.capabilityRef ?? this.capability.id; }

  /** Проверяет if a tool is allowed for this capability */
  isToolAllowed(toolId: ToolId): boolean {
    return this.capability.allowedTools.includes(toolId);
  }

  revalidateAccess(): void { this.revalidate?.(); }

  /** Получает workspace read utility */
  getReadTool() {
    return this.workspaceTools;
  }

  /** Получает git utilities */
  getGitTools() {
    return this.gitTools;
  }

  /** Получает action gateway */
  getActionGateway() {
    return this.gateway;
  }
}
