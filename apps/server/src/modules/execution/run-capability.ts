/**
 * RunCapability defines the security boundary for an agent run.
 * It binds a run to a specific role, workspace, and permitted tools.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import { ActionGateway } from './action-gateway.js';
import { GitTools } from './git-tools.js';
import { WorkspaceTools } from './workspace-tools.js';

export type RoleName = 'developer' | 'reviewer' | 'qa' | 'integration' | 'coordinator' | 'architect';
export type ToolId = 'workspace.read' | 'workspace.search' | 'workspace.patch' | 'git.status' | 'git.diff' | 'git.commit';

export interface RunCapabilityDef {
  id: string;
  role: RoleName;
  workspace: string;
  allowedTools: ToolId[];
}

export class RunCapability {
  private resolver: PathResolver;
  private gateway: ActionGateway;
  private workspaceTools: WorkspaceTools;
  private gitTools: GitTools | null;

  constructor(public capability: RunCapabilityDef) {
    this.resolver = new PathResolver();
    this.gateway = new ActionGateway(this.resolver, capability.workspace);
    this.workspaceTools = new WorkspaceTools(this.resolver, capability.workspace);
    this.gitTools = capability.workspace ? new GitTools(capability.workspace) : null;
  }

  /** Check if a tool is allowed for this capability */
  isToolAllowed(toolId: ToolId): boolean {
    return this.capability.allowedTools.includes(toolId);
  }

  /** Get workspace read utility */
  getReadTool() {
    return this.workspaceTools;
  }

  /** Get git utilities */
  getGitTools() {
    return this.gitTools;
  }

  /** Get action gateway */
  getActionGateway() {
    return this.gateway;
  }
}
