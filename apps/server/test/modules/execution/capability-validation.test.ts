import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { loadValidatedCapability } from '../../../src/modules/execution/capability-validation.js';
import { McpServer } from '../../../src/modules/execution/mcp/mcp-server.js';

function fixture(status: string, json?: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'capability-workspace-'));
  const value = JSON.parse(json ?? JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'reviewer', workspace, allowedTools: ['submit_result'] })) as Record<string, unknown>;
  if (value.workspace === '/tmp/work') value.workspace = workspace;
  const db = createSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'capability-')), 'state.sqlite'));
  db.exec('CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, capability_ref TEXT UNIQUE, capability_json TEXT, task_id TEXT, epic_id TEXT)');
  db.exec('CREATE TABLE worktrees (id TEXT PRIMARY KEY, repo_path TEXT, path TEXT, branch TEXT, created_at TEXT, removed_at TEXT)');
  db.exec('CREATE TABLE integration_attempts (id TEXT PRIMARY KEY, worktree_path TEXT, integration_run_id TEXT, status TEXT, created_at TEXT)');
  const role = value.role === 'integration' ? 'Integration' : 'Reviewer';
  const runId = value.runId === 'run-1' ? 'run-1' : 'run-1';
  const taskId = 'task-1';
  db.run('INSERT INTO agent_runs VALUES ($id,$role,$status,$ref,$json,$taskId,NULL)', { id: runId, role, status, ref: 'cap-1', json: JSON.stringify(value), taskId });
  db.run('INSERT INTO worktrees VALUES ($id,$repo,$path,$branch,$created,NULL)', { id: taskId, repo: workspace, path: workspace, branch: `task/${taskId}`, created: new Date().toISOString() });
  db.run('INSERT INTO integration_attempts VALUES ($id,$path,$run,$status,$created)', { id: 'integration-1', path: workspace, run: runId, status: 'PREPARED', created: new Date().toISOString() });
  return db;
}

describe('issued capability validation', () => {
  it.each(['CANCELLED', 'COMPLETED'])('rejects %s runs', (status) => {
    const db = fixture(status);
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/inactive/);
    db.close();
  });
  it('rejects a reused reference and mismatched binding', () => {
    const db = fixture('IN_PROGRESS', JSON.stringify({ runId: 'run-2', capabilityRef: 'cap-1', role: 'reviewer', workspace: '/tmp/work', allowedTools: ['submit_result'] }));
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/match/);
    db.close();
  });
  it('accepts only an active authoritative binding', () => {
    const db = fixture('STARTED');
    expect(loadValidatedCapability(db, 'cap-1').runId).toBe('run-1');
    db.close();
  });
  it('rejects a workspace that does not match the persisted task worktree', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'foreign-workspace-'));
    const db = fixture('STARTED', JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'reviewer', workspace, allowedTools: ['submit_result'] }));
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/workspace|worktree|match/i);
    db.close();
  });
  it('revokes an already-started MCP server when the persisted run is cancelled', async () => {
    const db = fixture('IN_PROGRESS');
    const server = new McpServer(loadValidatedCapability(db, 'cap-1'));
    db.run("UPDATE agent_runs SET status = 'CANCELLED' WHERE id = 'run-1'");
    const result = await server.callTool('submit_result', { payload: { version: '1.0', outcome: 'PASS' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inactive/);
    db.close();
  });

  it('keeps Integration read/test-only and cannot merge or commit', () => {
    const db = fixture('STARTED', JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'integration', workspace: '/tmp/work', allowedTools: ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'] }));
    const server = new McpServer(loadValidatedCapability(db, 'cap-1'), { expectedRole: 'Integration' });
    expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
      'workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result',
    ]);
    expect(server.getAvailableTools().some((tool) => tool.name === 'git.commit')).toBe(false);
    expect(server.getAvailableTools().some((tool) => tool.name === 'git.merge')).toBe(false);
    db.close();
  });
});
