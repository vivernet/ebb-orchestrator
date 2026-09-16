/**
 * RunCapability defines the security boundary for an agent run.
 * It binds a run to a specific role, workspace, and permitted tools.
 */
import { PathResolver } from '../../platform/security/path-resolver';
import { ActionGateway } from './action-gateway';
import { GitTools } from './git-tools';
import { WorkspaceTools } from './workspace-tools';

export type RoleName = 'developer' | 'reviewer' | 'qa' | 'integration' | 'coordinator' | 'architect';
export type ToolId = 'workspace.read' | 'workspace.search' | 'workspace.patch' | 'git.status' | 'git.diff' | 'git.commit';

export type RunCapability = {
  id: string;
  role: RoleName;
  workspace: string;
  allowedTools: ToolId[];
};

export class RunCapability {
  private resolver: PathResolver;
  private gateway: ActionGateway;
  private workspaceTools: WorkspaceTools;
  private gitTools: GitTools | null;

  constructor(public capability: RunCapability) {
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
