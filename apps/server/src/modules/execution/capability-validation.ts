import type { Database } from '../../platform/database/database.js';
import { RunCapability, type RoleName, type ToolId } from './run-capability.js';

const roles = new Set<RoleName>(['developer', 'reviewer', 'qa', 'integration', 'coordinator', 'architect']);
const tools = new Set<string>([
  'workspace.read', 'workspace.search', 'workspace.patch', 'project.test', 'project.lint',
  'project.typecheck', 'project.build', 'command.exec', 'command.shell', 'git.status',
  'git.diff', 'git.commit', 'artifact.write', 'submit_result',
]);

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

/** Load a capability only after checking its authoritative, active run row. */
export function loadValidatedCapability(db: Database, capabilityRef: string): RunCapability {
  const validate = (): void => {
    const active = db.get<{ status: string; capability_ref: string | null; capability_json: string | null }>(
      'SELECT status, capability_ref, capability_json FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
    if (!active || !['STARTED', 'IN_PROGRESS'].includes(active.status) || active.capability_ref !== capabilityRef || !active.capability_json) throw new Error('unknown or inactive capability reference');
  };
  const row = db.get<{ id: string; role: string; status: string; capability_ref: string | null; capability_json: string | null }>(
    'SELECT id, role, status, capability_ref, capability_json FROM agent_runs WHERE capability_ref = $ref', { ref: capabilityRef });
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
  if (projectConfig !== undefined && !isProjectConfig(projectConfig)) throw new Error('malformed project configuration');
  return new RunCapability({ id: capabilityRef, capabilityRef, runId, role: role.toLowerCase() as RoleName, workspace, allowedTools: allowedTools as ToolId[], ...(projectConfig ? { projectConfig } : {}) }, validate);
}
