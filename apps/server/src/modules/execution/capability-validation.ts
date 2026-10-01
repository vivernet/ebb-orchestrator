import type { Database } from '../../platform/database/database.js';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RunCapability, SUPPORTED_TOOL_IDS, type RoleName, type ToolId } from './run-capability.js';
import { validateCommandPolicies } from './command-policy.js';
import { approvedProjectConfigRevisionTx, approvedProjectConfigSnapshotTx } from '../projects/project-config-service.js';

const roles = new Set<RoleName>(['developer', 'reviewer', 'qa', 'integration', 'coordinator', 'product_manager', 'architect']);
const tools = new Set<string>(SUPPORTED_TOOL_IDS);
const planningTools = new Set<ToolId>(['workspace.read', 'workspace.search', 'git.status', 'git.diff', 'submit_result']);
const requestPlanningRoles = new Set(['coordinator', 'product_manager', 'architect']);

function isProjectConfig(value: unknown): value is NonNullable<import('./project-actions.js').ProjectConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const commands = (value as { commands?: unknown }).commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return false;
  const entries = Object.values(commands as Record<string, unknown>);
  const validCommands = entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const command = entry as { executable?: unknown; args?: unknown };
    return typeof command.executable === 'string' && Array.isArray(command.args) && command.args.every((arg) => typeof arg === 'string');
  });
  if (!validCommands) return false;
  const commandPolicies = (value as { commandPolicies?: unknown }).commandPolicies;
  return commandPolicies === undefined || validateCommandPolicies(
    (value as { workspace?: string }).workspace ?? '',
    commandPolicies,
  );
}

function canonicalExistingPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function sameCanonicalPath(left: string, right: string): boolean {
  const leftCanonical = canonicalExistingPath(left);
  const rightCanonical = canonicalExistingPath(right);
  if (!leftCanonical || !rightCanonical) return false;
  return process.platform === 'win32'
    ? leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
    : leftCanonical === rightCanonical;
}

type PersistedRunBinding = { id: string; role: string; task_id?: string | null; epic_id?: string | null };

function assertRequestPlanningBinding(db: Database, row: PersistedRunBinding, issued: Record<string, unknown>, workspace: string): string {
  const requestId = issued.requestId;
  const projectId = issued.projectId;
  const runPurpose = db.get<{ epic_id: string | null; trigger_reason: string | null }>(
    'SELECT epic_id,trigger_reason FROM agent_runs WHERE id=$runId', { runId: row.id });
  const expectedTrigger = row.role === 'coordinator' ? 'planning-request' : 'planning-request-role';
  if (row.task_id !== null || runPurpose?.epic_id !== null || runPurpose?.trigger_reason !== expectedTrigger || !requestPlanningRoles.has(row.role.toLowerCase())
    || typeof requestId !== 'string' || typeof projectId !== 'string') {
    throw new Error('invalid request planning binding');
  }
  const request = db.get<{ project_id: string; status: string; coordinator_run_id: string | null; planning_decisions_required: number }>(
    'SELECT project_id,status,coordinator_run_id,planning_decisions_required FROM planning_requests WHERE id=$requestId', { requestId });
  const linkedCoordinator = row.role === 'coordinator' && request?.coordinator_run_id === row.id;
  const linkedReview = row.role !== 'coordinator' && Boolean(db.get<{ run_id: string }>(
    'SELECT run_id FROM planning_request_role_runs WHERE request_id=$requestId AND role=$role AND run_id=$runId',
    { requestId, role: row.role.toLowerCase(), runId: row.id }));
  if (!request || request.project_id !== projectId || request.status !== 'PLANNING' || (!linkedCoordinator && !linkedReview) ||
      (row.role !== 'coordinator' && (request.coordinator_run_id === null || request.planning_decisions_required !== 1))) {
    throw new Error('request planning run binding is inactive or mismatched');
  }
  const repository = db.get<{ repository_path: string }>(
    `SELECT o.repository_path FROM projects p JOIN onboarding_configs o ON o.project_id=p.id
       JOIN approvals a ON a.id=o.approval_id AND a.subject_id=p.id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE'
      WHERE p.id=$projectId AND p.status='ACTIVE' AND o.status='ACTIVE' AND a.status='APPROVED'`, { projectId });
  if (!repository || !sameCanonicalPath(workspace, repository.repository_path)) throw new Error('request planning workspace is not bound to the approved project repository');
  return projectId;
}

function assertEpicWorkspaceBinding(db: Database, row: PersistedRunBinding, workspace: string, issuedEpicId: unknown): string {
  if (!row.epic_id || issuedEpicId !== row.epic_id || row.task_id !== null) throw new Error('invalid Epic execution binding');
  const phase = db.get<{ phase: string; role: string; status: string; task_id: string | null }>(
    'SELECT phase,role,status,task_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND agent_run_id=$runId',
    { epicId: row.epic_id, runId: row.id });
  const runPurpose = db.get<{ trigger_reason: string | null }>('SELECT trigger_reason FROM agent_runs WHERE id=$runId', { runId: row.id });
  if (!phase || phase.status !== 'RUNNING' || phase.task_id !== null || phase.role.toLowerCase() !== row.role.toLowerCase() || runPurpose?.trigger_reason !== `epic-${phase.phase}`) {
    throw new Error('Epic capability is not bound to an active orchestration phase');
  }
  const epic = db.get<{ id: string; project_id: string; display_id: string }>(
    "SELECT id,project_id,display_id FROM epics WHERE id=$epicId AND status IN ('OPEN','IN_PROGRESS')", { epicId: row.epic_id });
  if (!epic) throw new Error('Epic execution target is unavailable');
  const repository = db.get<{ repository_path: string; facts_json: string; proposed_json: string }>(
    `SELECT o.repository_path,o.facts_json,o.proposed_json FROM projects p JOIN onboarding_configs o ON o.project_id=p.id
       JOIN approvals a ON a.id=o.approval_id AND a.subject_id=p.id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE'
      WHERE p.id=$projectId AND p.status='ACTIVE' AND o.status='ACTIVE' AND a.status='APPROVED'`, { projectId: epic.project_id });
  if (!repository) throw new Error('Epic project onboarding is not active and approved');
  if (phase.phase === 'integration' && phase.role.toLowerCase() === 'integration') {
    let facts: Record<string, unknown> = {};
    let proposed: Record<string, unknown> = {};
    try { facts = JSON.parse(repository.facts_json) as Record<string, unknown>; } catch { /* fail closed below */ }
    try { proposed = JSON.parse(repository.proposed_json) as Record<string, unknown>; } catch { /* fail closed below */ }
    const defaultBranch = typeof proposed.defaultBranch === 'string' ? proposed.defaultBranch
      : typeof facts.defaultBranch === 'string' ? facts.defaultBranch : undefined;
    const attempts = db.all<{ repository_path: string; source_branch: string; target_branch: string; worktree_path: string; expected_target_sha: string; source_sha: string; status: string; integration_run_id: string | null }>(
      `SELECT repository_path,source_branch,target_branch,worktree_path,expected_target_sha,source_sha,status,integration_run_id
         FROM integration_attempts
        WHERE integration_run_id=$runId AND status IN ('PREPARED','MERGING')`, { runId: row.id });
    const attempt = attempts[0];
    const epicBranch = `epic/${epic.display_id}`;
    if (attempts.length !== 1 || !attempt || attempt.integration_run_id !== row.id ||
        !sameCanonicalPath(attempt.repository_path, repository.repository_path) ||
        attempt.source_branch !== epicBranch || !defaultBranch || attempt.target_branch !== defaultBranch ||
        !attempt.source_sha || !attempt.expected_target_sha ||
        !sameCanonicalPath(workspace, attempt.worktree_path)) {
      throw new Error('Epic Integration capability is not bound to its exact persisted Integration attempt');
    }
    return epic.project_id;
  }
  const worktreeId = `epic:${epic.id}`;
  const branch = `epic/${epic.display_id}`;
  const worktree = db.get<{ repo_path: string; path: string; branch: string; removed_at: string | null }>(
    'SELECT repo_path,path,branch,removed_at FROM worktrees WHERE id=$worktreeId', { worktreeId });
  const operation = db.get<{ type: string; status: string; repo_path: string; branch_name: string | null; worktree_id: string | null; target_ref: string | null }>(
    'SELECT type,status,repo_path,branch_name,worktree_id,target_ref FROM git_operations WHERE worktree_id=$worktreeId ORDER BY created_at DESC LIMIT 1', { worktreeId });
  if (!sameCanonicalPath(workspace, workspace) || !worktree || worktree.removed_at !== null || worktree.branch !== branch ||
      !sameCanonicalPath(worktree.path, workspace) || !sameCanonicalPath(worktree.repo_path, repository.repository_path) ||
      operation?.type !== 'CREATE_WORKTREE' || operation.status !== 'VERIFIED' || operation.worktree_id !== worktreeId ||
      operation.branch_name !== branch || !operation.target_ref || !sameCanonicalPath(operation.repo_path, repository.repository_path)) {
    throw new Error('capability workspace is not bound to the verified managed Epic worktree');
  }
  return epic.project_id;
}

/**
 * Проверяет, что workspace capability совпадает с persisted managed worktree.
 *
 * @param db Авторитетная база состояния Orchestrator.
 * @param row Persisted agent run binding.
 * @param workspace Workspace из capability JSON.
 * @throws {Error} Если путь не является существующим managed worktree.
 */
function assertManagedWorkspaceBinding(
  db: Database,
  row: PersistedRunBinding,
  workspace: string,
): void {
  if (!sameCanonicalPath(workspace, workspace)) {
    throw new Error('capability workspace is not an absolute existing path');
  }

  if (!row.task_id) throw new Error('capability workspace has no task binding');
  const task = db.get<{ project_id: string; epic_id: string | null; display_id: string | null }>(
    `SELECT t.project_id,t.epic_id,e.display_id
       FROM tasks t LEFT JOIN epics e ON e.id=t.epic_id
      WHERE t.id=$taskId`, { taskId: row.task_id });
  if (!task || (row.epic_id ?? null) !== task.epic_id || (task.epic_id && !task.display_id)) {
    throw new Error('capability task binding does not match its persisted Epic');
  }
  const onboarding = db.get<{ repository_path: string; facts_json: string; proposed_json: string }>(
    `SELECT o.repository_path,o.facts_json,o.proposed_json
       FROM projects p JOIN onboarding_configs o ON o.project_id=p.id
       JOIN approvals a ON a.id=o.approval_id AND a.subject_id=p.id AND a.subject_type='PROJECT'
         AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'
      WHERE p.id=$projectId AND p.status='ACTIVE' AND o.status='ACTIVE'`, { projectId: task.project_id });
  if (!onboarding) throw new Error('task workspace project onboarding is not active and approved');
  let facts: Record<string, unknown> = {};
  let proposed: Record<string, unknown> = {};
  try { facts = JSON.parse(onboarding.facts_json) as Record<string, unknown>; } catch { /* fail closed below */ }
  try { proposed = JSON.parse(onboarding.proposed_json) as Record<string, unknown>; } catch { /* fail closed below */ }
  const defaultBranch = typeof proposed.defaultBranch === 'string' ? proposed.defaultBranch
    : typeof facts.defaultBranch === 'string' ? facts.defaultBranch : undefined;
  const expectedTarget = task.epic_id ? `epic/${task.display_id}` : defaultBranch;
  if (!expectedTarget) throw new Error('task workspace target branch is unavailable');
  const worktree = db.get<{ repo_path: string; path: string; branch: string; removed_at: string | null }>(
    `SELECT repo_path,path,branch,removed_at
       FROM worktrees
      WHERE id = $taskId AND branch = $branch AND removed_at IS NULL`,
    { taskId: row.task_id, branch: `task/${row.task_id}` },
  );
  const operation = db.get<{ id: string; type: string; status: string; repo_path: string; branch_name: string | null; worktree_id: string | null; target_ref: string | null; verified_at: string | null }>(
    `SELECT id,type,status,repo_path,branch_name,worktree_id,target_ref,verified_at
       FROM git_operations WHERE worktree_id=$taskId ORDER BY created_at DESC,id DESC LIMIT 1`, { taskId: row.task_id });
  if (!worktree || !sameCanonicalPath(worktree.path, worktree.path) || !sameCanonicalPath(worktree.repo_path, onboarding.repository_path) ||
      operation?.type !== 'CREATE_WORKTREE' || operation.status !== 'VERIFIED' || !operation.verified_at ||
      operation.worktree_id !== row.task_id || operation.branch_name !== worktree.branch ||
      !sameCanonicalPath(operation.repo_path, onboarding.repository_path) || operation.target_ref !== expectedTarget) {
    throw new Error('capability workspace is not bound to the exact verified managed task worktree');
  }

  if (row.role.toLowerCase() === 'integration') {
    const attempts = db.all<{ repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; integration_run_id: string | null; status: string }>(
      `SELECT repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status
         FROM integration_attempts
        WHERE integration_run_id=$runId AND status IN ('PREPARED','MERGING')`, { runId: row.id });
    const attempt = attempts[0];
    if (attempts.length !== 1 || !attempt || attempt.integration_run_id !== row.id ||
        !sameCanonicalPath(attempt.repository_path, onboarding.repository_path) ||
        attempt.source_branch !== `task/${row.task_id}` || attempt.target_branch !== expectedTarget ||
        !attempt.expected_target_sha || !attempt.source_sha || !sameCanonicalPath(workspace, attempt.worktree_path)) {
      throw new Error('capability workspace is not bound to the exact task Integration provenance');
    }
    return;
  }

  if (!sameCanonicalPath(workspace, worktree.path)) {
    throw new Error('capability workspace is not bound to the exact verified managed task worktree');
  }
}

/** загружать Объект capability только после checking its authoritative, активный run row. */
export function loadValidatedCapability(db: Database, capabilityRef: string): RunCapability {
  const validate = (): void => {
    const active = db.get<{ status: string; capability_ref: string | null; capability_json: string | null }>(
      'SELECT status, capability_ref, capability_json FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
    if (!active || !['STARTED', 'IN_PROGRESS'].includes(active.status) || active.capability_ref !== capabilityRef || !active.capability_json) throw new Error('unknown or inactive capability reference');
    if (planningIssued && planningWorkspace && planningRow) {
      const projectId = assertRequestPlanningBinding(db, planningRow, planningIssued, planningWorkspace);
      const activeConfig = db.transaction((tx) => approvedProjectConfigSnapshotTx(tx, projectId));
      if (activeConfig?.revisionId !== planningRevisionId) throw new Error('request planning Project Config revision is no longer active');
    }
    if (epicIssued && epicWorkspace && epicRow) {
      const projectId = assertEpicWorkspaceBinding(db, epicRow, epicWorkspace, epicIssued.epicId);
      const activeConfig = db.transaction((tx) => approvedProjectConfigSnapshotTx(tx, projectId));
      if (activeConfig?.revisionId !== epicRevisionId) throw new Error('Epic Project Config revision is no longer active');
    }
  };
  let planningIssued: Record<string, unknown> | undefined;
  let planningWorkspace: string | undefined;
  let planningRow: PersistedRunBinding | undefined;
  let planningRevisionId: string | undefined;
  let epicIssued: Record<string, unknown> | undefined;
  let epicWorkspace: string | undefined;
  let epicRow: PersistedRunBinding | undefined;
  let epicRevisionId: string | undefined;
  const row = db.get<{ id: string; role: string; status: string; capability_ref: string | null; capability_json: string | null; task_id?: string | null; epic_id?: string | null }>(
    'SELECT id, role, status, capability_ref, capability_json, task_id, epic_id FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
  if (!row || !['STARTED', 'IN_PROGRESS'].includes(row.status)) throw new Error('unknown or inactive capability reference');
  if (row.capability_ref !== capabilityRef || !row.capability_json) throw new Error('malformed capability reference');
  let value: unknown;
  try { value = JSON.parse(row.capability_json); } catch { throw new Error('malformed capability reference'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed capability reference');
  const issued = value as Record<string, unknown>;
  const runId = issued.runId;
  const role = issued.role;
  const ref = issued.capabilityRef;
  const workspace = issued.workspace;
  const allowedTools = issued.allowedTools;
  const projectConfig = issued.projectConfig;
  const approvedProjectConfig = issued.approvedProjectConfig;
  if (runId !== row.id || typeof runId !== 'string' || typeof role !== 'string' || role.toLowerCase() !== row.role.toLowerCase() ||
      ref !== capabilityRef || typeof workspace !== 'string' || !Array.isArray(allowedTools) ||
       allowedTools.length === 0 || allowedTools.some((tool) => typeof tool !== 'string' || !tools.has(tool)) ||
       new Set(allowedTools).size !== allowedTools.length || !roles.has(role.toLowerCase() as RoleName)) {
    throw new Error('capability does not match authoritative agent run');
  }
  const requestPlanning = row.task_id === null && row.epic_id === null && requestPlanningRoles.has(row.role.toLowerCase());
  const epicExecution = row.task_id === null && row.epic_id !== null;
  const planningProjectId = requestPlanning
    ? assertRequestPlanningBinding(db, row, issued, workspace)
    : undefined;
  const epicProjectId = epicExecution
    ? assertEpicWorkspaceBinding(db, row, workspace, issued.epicId)
    : undefined;
  if (!requestPlanning && !epicExecution) assertManagedWorkspaceBinding(db, row, workspace);
  if (requestPlanning && (issued.epicId !== undefined || projectConfig !== undefined || allowedTools.some((tool) => !planningTools.has(tool as ToolId)))) {
    throw new Error('request planning capability exceeds its read-only request binding');
  }
  if (epicExecution && (issued.requestId !== undefined || issued.projectId !== undefined || projectConfig !== undefined)) {
    throw new Error('Epic execution capability contains an incompatible planning binding');
  }
  if (requestPlanning) { planningIssued = issued; planningWorkspace = workspace; planningRow = row; }
  if (epicExecution) { epicIssued = issued; epicWorkspace = workspace; epicRow = row; }
  const validatedProjectConfig = projectConfig === undefined
    ? undefined
    : { ...(projectConfig as Record<string, unknown>), workspace };
  if (validatedProjectConfig !== undefined && !isProjectConfig(validatedProjectConfig)) throw new Error('malformed project configuration');
  let validatedApprovedProjectConfig: ReturnType<typeof approvedProjectConfigRevisionTx> | undefined;
  if (approvedProjectConfig !== undefined) {
    if (validatedProjectConfig) throw new Error('approved Project Config binding conflicts with run capability');
    const task = row.task_id ? db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id=$taskId', { taskId: row.task_id }) : undefined;
    const claimedRevisionId = (approvedProjectConfig as { revisionId?: unknown } | null)?.revisionId;
    const configProjectId = planningProjectId ?? epicProjectId ?? task?.project_id;
    if (!configProjectId || typeof claimedRevisionId !== 'string') throw new Error('malformed approved Project Config binding');
    validatedApprovedProjectConfig = db.transaction((tx) => {
      if (requestPlanning || epicExecution) {
        const active = approvedProjectConfigSnapshotTx(tx, configProjectId);
        if (!active || active.revisionId !== claimedRevisionId) throw new Error('request/Epic Project Config revision is no longer active');
      }
      return approvedProjectConfigRevisionTx(tx, configProjectId, claimedRevisionId);
    });
    const { files: _files, ...binding } = validatedApprovedProjectConfig;
    if (JSON.stringify(approvedProjectConfig) !== JSON.stringify(binding)) throw new Error('approved Project Config binding failed integrity validation');
  }
  if ((requestPlanning || epicExecution) && !validatedApprovedProjectConfig) {
    const projectId = planningProjectId ?? epicProjectId;
    if (projectId) {
      const active = db.transaction((tx) => approvedProjectConfigSnapshotTx(tx, projectId));
      if (active) throw new Error('request/Epic run requires approved Project Config binding');
    }
  }
  if (requestPlanning) planningRevisionId = validatedApprovedProjectConfig?.revisionId;
  if (epicExecution) epicRevisionId = validatedApprovedProjectConfig?.revisionId;
  return new RunCapability({ id: capabilityRef, capabilityRef, runId, role: role.toLowerCase() as RoleName, workspace,
    ...(typeof issued.requestId === 'string' ? { requestId: issued.requestId } : {}),
    ...(typeof issued.projectId === 'string' ? { projectId: issued.projectId } : {}),
    ...(typeof issued.epicId === 'string' ? { epicId: issued.epicId } : {}),
    allowedTools: allowedTools as ToolId[], ...(validatedProjectConfig ? { projectConfig: validatedProjectConfig } : {}), ...(validatedApprovedProjectConfig ? { approvedProjectConfig: validatedApprovedProjectConfig } : {}) }, validate);
}
