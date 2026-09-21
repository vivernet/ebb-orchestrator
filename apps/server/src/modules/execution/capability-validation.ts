import type { Database } from '../../platform/database/database.js';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RunCapability, SUPPORTED_TOOL_IDS, type RoleName, type ToolId } from './run-capability.js';

const roles = new Set<RoleName>(['developer', 'reviewer', 'qa', 'integration', 'coordinator', 'architect']);
const tools = new Set<string>(SUPPORTED_TOOL_IDS);

function isProjectConfig(value: unknown): value is NonNullable<import('./project-actions.js').ProjectConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const commands = (value as { commands?: unknown }).commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return false;
  const entries = Object.values(commands as Record<string, unknown>);
  return entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const command = entry as { executable?: unknown; args?: unknown };
    return typeof command.executable === 'string' && Array.isArray(command.args) && command.args.every((arg) => typeof arg === 'string');
  });
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

type PersistedRunBinding = { id: string; role: string; task_id?: string | null };

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

  if (row.role.toLowerCase() === 'integration') {
    const attempt = db.get<{ worktree_path: string; integration_run_id: string | null; status: string }>(
      `SELECT worktree_path, integration_run_id, status
         FROM integration_attempts
        WHERE integration_run_id = $runId
          AND status IN ('PREPARED', 'MERGING')
        ORDER BY created_at DESC LIMIT 1`,
      { runId: row.id },
    );
    if (!attempt || attempt.integration_run_id !== row.id || !sameCanonicalPath(workspace, attempt.worktree_path)) {
      throw new Error('capability workspace is not bound to the active integration worktree');
    }
    return;
  }

  if (!row.task_id) throw new Error('capability workspace has no task binding');
  const worktree = db.get<{ path: string; branch: string; removed_at: string | null }>(
    `SELECT path, branch, removed_at
       FROM worktrees
      WHERE id = $taskId AND branch = $branch AND removed_at IS NULL`,
    { taskId: row.task_id, branch: `task/${row.task_id}` },
  );
  if (!worktree || !sameCanonicalPath(workspace, worktree.path)) {
    throw new Error('capability workspace is not bound to the active task worktree');
  }
}

/** загружать Объект capability только после checking its authoritative, активный run row. */
export function loadValidatedCapability(db: Database, capabilityRef: string): RunCapability {
  const validate = (): void => {
    const active = db.get<{ status: string; capability_ref: string | null; capability_json: string | null }>(
      'SELECT status, capability_ref, capability_json FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
    if (!active || !['STARTED', 'IN_PROGRESS'].includes(active.status) || active.capability_ref !== capabilityRef || !active.capability_json) throw new Error('unknown or inactive capability reference');
  };
  const row = db.get<{ id: string; role: string; status: string; capability_ref: string | null; capability_json: string | null; task_id?: string | null }>(
    'SELECT id, role, status, capability_ref, capability_json, task_id FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
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
  if (runId !== row.id || typeof runId !== 'string' || typeof role !== 'string' || role.toLowerCase() !== row.role.toLowerCase() ||
      ref !== capabilityRef || typeof workspace !== 'string' || !Array.isArray(allowedTools) ||
       allowedTools.length === 0 || allowedTools.some((tool) => typeof tool !== 'string' || !tools.has(tool)) ||
       new Set(allowedTools).size !== allowedTools.length || !roles.has(role.toLowerCase() as RoleName)) {
    throw new Error('capability does not match authoritative agent run');
  }
  assertManagedWorkspaceBinding(db, row, workspace);
  if (projectConfig !== undefined && !isProjectConfig(projectConfig)) throw new Error('malformed project configuration');
  return new RunCapability({ id: capabilityRef, capabilityRef, runId, role: role.toLowerCase() as RoleName, workspace, allowedTools: allowedTools as ToolId[], ...(projectConfig ? { projectConfig } : {}) }, validate);
}
