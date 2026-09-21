// Типы решений Permission Decision types - ordered by restrictiveness
// Порядок решений: ALLOW < ASK < DENY < ABSOLUTE_DENY.
export enum PermissionDecision {
  ALLOW = 'ALLOW',
  ASK = 'ASK',
  DENY = 'DENY',
  ABSOLUTE_DENY = 'ABSOLUTE_DENY',
}

// Канонический ActionId set - shared between Permission Engine and Action Gateway
export enum ActionId {
  // Операции workspace
  WorkspaceRead = 'workspace.read',
  WorkspaceSearch = 'workspace.search',
  WorkspacePatch = 'workspace.patch',
  
  // Операции project
  ProjectTest = 'project.test',
  ProjectLint = 'project.lint',
  ProjectTypecheck = 'project.typecheck',
  ProjectBuild = 'project.build',
  
  // Выполнение команд
  CommandExec = 'command.exec',
  CommandShell = 'command.shell',
  
  // Операции Git
  GitStatus = 'git.status',
  GitDiff = 'git.diff',
  GitCommit = 'git.commit',
  
  // Операции с artifacts
  ArtifactWrite = 'artifact.write',
  SubmitResult = 'submit_result',
}

// Уровни scope levels
export enum PolicyScope {
  Global = 'global',
  Project = 'project',
  Role = 'role',
  Task = 'task',
}

// Уровни rule types
export enum PolicyRuleType {
  Allow = 'allow',
  Ask = 'ask',
  Deny = 'deny',
  AbsoluteDeny = 'absolute_deny',
}

// Результат input from Policy
export interface PolicyRule {
  scope: PolicyScope;
  scopeRef?: string; // project id, role name, task id, etc.
  actions: ActionId[];
  type: PolicyRuleType;
}

// Объединённые evaluation inputs
export interface EvaluationInput {
  capability: ActionId[];
  action: ActionId;
  globalPolicy?: PolicyRule[];
  projectPolicy?: PolicyRule[];
  rolePolicy?: PolicyRule[];
  taskPolicy?: PolicyRule[];
}

// Результат result with reasoning
export interface EvaluationResult {
  decision: PermissionDecision;
  reason: string;
  matchedPolicyRefs: {
    scope: PolicyScope;
    scopeRef?: string;
    type: PolicyRuleType;
  }[];
}
