// Permission Decision types - ordered by restrictiveness
// ALLOW < ASK < DENY < ABSOLUTE_DENY
export enum PermissionDecision {
  ALLOW = 'ALLOW',
  ASK = 'ASK',
  DENY = 'DENY',
  ABSOLUTE_DENY = 'ABSOLUTE_DENY',
}

// Canonical ActionId set - shared between Permission Engine and Action Gateway
export enum ActionId {
  // Workspace operations
  WorkspaceRead = 'workspace.read',
  WorkspaceSearch = 'workspace.search',
  WorkspacePatch = 'workspace.patch',
  
  // Project operations
  ProjectTest = 'project.test',
  ProjectLint = 'project.lint',
  ProjectTypecheck = 'project.typecheck',
  ProjectBuild = 'project.build',
  
  // Command execution
  CommandExec = 'command.exec',
  CommandShell = 'command.shell',
  
  // Git operations
  GitStatus = 'git.status',
  GitDiff = 'git.diff',
  GitCommit = 'git.commit',
  
  // Artifact operations
  ArtifactWrite = 'artifact.write',
  SubmitResult = 'submit_result',
}

// Policy scope levels
export enum PolicyScope {
  Global = 'global',
  Project = 'project',
  Role = 'role',
  Task = 'task',
}

// Policy rule types
export enum PolicyRuleType {
  Allow = 'allow',
  Ask = 'ask',
  Deny = 'deny',
  AbsoluteDeny = 'absolute_deny',
}

// Evaluation input from Policy
export interface PolicyRule {
  scope: PolicyScope;
  scopeRef?: string; // project id, role name, task id, etc.
  actions: ActionId[];
  type: PolicyRuleType;
}

// Combined evaluation inputs
export interface EvaluationInput {
  capability: ActionId[];
  action: ActionId;
  globalPolicy?: PolicyRule[];
  projectPolicy?: PolicyRule[];
  rolePolicy?: PolicyRule[];
  taskPolicy?: PolicyRule[];
}

// Evaluation result with reasoning
export interface EvaluationResult {
  decision: PermissionDecision;
  reason: string;
  matchedPolicyRefs: {
    scope: PolicyScope;
    scopeRef?: string;
    type: PolicyRuleType;
  }[];
}
