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
  const integrationWorkspace = value.role === 'integration' ? mkdtempSync(join(tmpdir(), 'capability-integration-')) : workspace;
  if (value.workspace === '/tmp/work') value.workspace = integrationWorkspace;
  const repository = mkdtempSync(join(tmpdir(), 'capability-repository-'));
  const db = createSqliteDatabase(join(mkdtempSync(join(tmpdir(), 'capability-')), 'state.sqlite'));
  db.exec('CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, capability_ref TEXT UNIQUE, capability_json TEXT, task_id TEXT, epic_id TEXT)');
  db.exec('CREATE TABLE worktrees (id TEXT PRIMARY KEY, repo_path TEXT, path TEXT, branch TEXT, created_at TEXT, removed_at TEXT)');
  db.exec('CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT, status TEXT, repo_path TEXT, branch_name TEXT, worktree_id TEXT, target_ref TEXT, created_at TEXT, verified_at TEXT)');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT)');
  db.exec('CREATE TABLE epics (id TEXT PRIMARY KEY, project_id TEXT, display_id TEXT)');
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, epic_id TEXT)');
  db.exec('CREATE TABLE approvals (id TEXT PRIMARY KEY, subject_id TEXT, subject_type TEXT, type TEXT, status TEXT)');
  db.exec('CREATE TABLE onboarding_configs (project_id TEXT, repository_path TEXT, facts_json TEXT, proposed_json TEXT, status TEXT, approval_id TEXT)');
  db.exec('CREATE TABLE integration_attempts (id TEXT PRIMARY KEY, repository_path TEXT, source_branch TEXT, target_branch TEXT, expected_target_sha TEXT, source_sha TEXT, worktree_path TEXT, integration_run_id TEXT, status TEXT, created_at TEXT)');
  const role = value.role === 'integration' ? 'Integration' : 'Reviewer';
  const runId = value.runId === 'run-1' ? 'run-1' : 'run-1';
  const taskId = 'task-1';
  const epicId = typeof value.epicId === 'string' ? value.epicId : null;
  const targetBranch = epicId ? 'epic/EPIC-1' : 'master';
  const now = new Date().toISOString();
  db.run('INSERT INTO agent_runs VALUES ($id,$role,$status,$ref,$json,$taskId,$epicId)', { id: runId, role, status, ref: 'cap-1', json: JSON.stringify(value), taskId, epicId });
  db.run('INSERT INTO worktrees VALUES ($id,$repo,$path,$branch,$created,NULL)', { id: taskId, repo: repository, path: workspace, branch: `task/${taskId}`, created: now });
  db.run("INSERT INTO git_operations VALUES ('worktree-op','CREATE_WORKTREE','VERIFIED',$repo,$branch,$taskId,$target,$created,$created)", { repo: repository, branch: `task/${taskId}`, taskId, target: targetBranch, created: now });
  db.run("INSERT INTO projects VALUES ('project-1','ACTIVE')");
  if (epicId) db.run("INSERT INTO epics VALUES ($epicId,'project-1','EPIC-1')", { epicId });
  db.run("INSERT INTO tasks VALUES ($taskId,'project-1',$epicId)", { taskId, epicId });
  db.run("INSERT INTO approvals VALUES ('onboarding-approval','project-1','PROJECT','WORKFLOW_CHANGE','APPROVED')");
  db.run("INSERT INTO onboarding_configs VALUES ('project-1',$repo,'{}',$proposed,'ACTIVE','onboarding-approval')", { repo: repository, proposed: JSON.stringify({ defaultBranch: 'master' }) });
  db.run('INSERT INTO integration_attempts VALUES ($id,$repo,$source,$target,$expected,$sourceSha,$path,$run,$status,$created)', { id: 'integration-1', repo: repository, source: `task/${taskId}`, target: targetBranch, expected: 'target-sha', sourceSha: 'source-sha', path: integrationWorkspace, run: runId, status: 'PREPARED', created: now });
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
  it('rejects a task workspace without an exact verified Git operation', () => {
    const db = fixture('STARTED');
    db.run("UPDATE git_operations SET status='STARTED',verified_at=NULL WHERE id='worktree-op'");
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/verified.*worktree|worktree.*verified/i);
    db.close();
  });
  it('rejects command policies whose allowed roots escape the managed workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'capability-command-root-'));
    const db = fixture('STARTED', JSON.stringify({
      runId: 'run-1', capabilityRef: 'cap-1', role: 'reviewer', workspace: '/tmp/work',
      allowedTools: ['command.exec'],
      projectConfig: { commands: {}, commandPolicies: [{
        id: 'bad-root', executable: process.execPath, args: [], allowedRoots: [outside], timeout: 5_000, maxOutput: 1_024,
      }] },
    }));

    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/malformed project configuration/);
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
    // Error message should be a safe public-facing message, not expose internal details like "inactive"
    expect(result.error).toBe('An internal error occurred');
    db.close();
  });

  it('keeps Integration read/test-only and cannot merge or commit', () => {
    const db = fixture('STARTED', JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'integration', epicId: 'epic-1', workspace: '/tmp/work', allowedTools: ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'] }));
    const server = new McpServer(loadValidatedCapability(db, 'cap-1'), { expectedRole: 'Integration' });
    expect(server.getAvailableTools().map((tool) => tool.name)).toEqual([
      'workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result',
    ]);
    expect(server.getAvailableTools().some((tool) => tool.name === 'git.commit')).toBe(false);
    expect(server.getAvailableTools().some((tool) => tool.name === 'git.merge')).toBe(false);
    db.close();
  });

  it('rejects child Integration provenance for a different target branch', () => {
    const db = fixture('STARTED', JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'integration', epicId: 'epic-1', workspace: '/tmp/work', allowedTools: ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'] }));
    db.run("UPDATE integration_attempts SET target_branch='master' WHERE id='integration-1'");
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/integration.*provenance|integration.*workspace|task.*worktree/i);
    db.close();
  });

  it('requires a verified managed Task worktree journal for child Integration', () => {
    const db = fixture('STARTED', JSON.stringify({ runId: 'run-1', capabilityRef: 'cap-1', role: 'integration', epicId: 'epic-1', workspace: '/tmp/work', allowedTools: ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'] }));
    db.run("UPDATE git_operations SET status='STARTED',verified_at=NULL WHERE id='worktree-op'");
    expect(() => loadValidatedCapability(db, 'cap-1')).toThrow(/verified.*worktree|worktree.*verified/i);
    db.close();
  });
});
