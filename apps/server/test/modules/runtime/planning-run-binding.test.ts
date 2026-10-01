import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import type { DatabaseTx } from '../../../src/platform/database/database.js';
import { runMigrations } from '../../../src/platform/database/migrator.js';
import { loadTestMigrations } from '../../helpers/migrations.js';
import { createRunContextInput, RunService } from '../../../src/modules/runtime/run-service.js';
import type { PreparedRunContext } from '../../../src/modules/context/context-types.js';
import { digestRunPromptBytesV1 } from '../../../src/modules/context/context-provenance.js';
import { FakeAgentRuntime } from '../../fakes/fake-agent-runtime.js';
import { ProjectConfigService } from '../../../src/modules/projects/project-config-service.js';
import { ApprovalService } from '../../../src/modules/approvals/approval-service.js';
import { loadValidatedCapability } from '../../../src/modules/execution/capability-validation.js';
import type { StartRunOptions } from '../../../src/modules/runtime/run-types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(withApprovedConfig = true) {
  const root = mkdtempSync(join(tmpdir(), 'ebb-planning-run-'));
  roots.push(root);
  mkdirSync(join(root, '.ebb-orchestrator'));
  writeFileSync(join(root, '.ebb-orchestrator', 'project.yaml'), 'schema_version: 1\nproject:\n  name: planning\n  default_branch: main\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  const db = createSqliteDatabase(':memory:');
  runMigrations(db, loadTestMigrations());
  const projectId = randomUUID();
  const requestId = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'planning','Planning','ACTIVE',$now,$now)", { id: projectId, now });
  const approvals = new ApprovalService(db);
  const approval = approvals.request({ type: 'WORKFLOW_CHANGE', subjectId: projectId, subjectType: 'PROJECT', requestedBy: 'local-user' });
  approvals.approve(approval.id, 'local-user');
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$root,'{}','null','ACTIVE',$approvalId,$now,$now)", { id: projectId, root, approvalId: approval.id, now });
  db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,status,created_at,updated_at) VALUES($id,$projectId,'Plan work','local-user','RECEIVED',$now,$now)", { id: requestId, projectId, now });
  if (withApprovedConfig) {
    const config = new ProjectConfigService(db, approvals);
    const candidate = config.capture(projectId);
    config.approve(projectId, candidate.candidateId, candidate.manifestHash);
  }
  const service = new RunService(db, new FakeAgentRuntime(), {
    prepare: (_tx, input) => testPreparedContext(input.prompt, input.role, input.subject),
  });
  const options = { taskId: null, requestId, projectId, role: 'coordinator', model: 'test', epicId: null, triggerReason: 'planning-request', contextVersion: '1', outputSchemaVersion: '1', capability: { workspace: root, allowedTools: ['workspace.read', 'workspace.search', 'submit_result'] } } satisfies StartRunOptions;
  return { root, db, projectId, requestId, service, options };
}

describe('project-scoped Coordinator planning run', () => {
  it('fails closed for an approved onboarding legacy project without Project Config lifecycle state', () => {
    const { db, options } = fixture(false);
    const productionService = new RunService(db, new FakeAgentRuntime());
    expect(() => productionService.prepareRun(testContextOptions(options))).toThrow(/Project Config|PROJECT_CONFIG|approved/i);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_runs')?.count).toBe(0);
    db.close();
  });

  it.skipIf(process.platform === 'win32')('prepares and claims atomically, then validates its read-only capability', () => {
    const { db, requestId, projectId, service, options } = fixture();
    const run = prepareRequestInTransaction(db, service, options, (tx, runId) => {
      tx.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId WHERE id=$requestId", { runId, requestId });
    });
    const capability = loadValidatedCapability(db, run.capabilityRef!);
    expect(run.taskId).toBeNull();
    expect(capability.capability.allowedTools).toEqual(['workspace.read', 'workspace.search', 'submit_result']);
    expect(capability.capability.approvedProjectConfig?.revisionId).toBeTruthy();
    db.run("UPDATE project_config_state SET config_status='DEGRADED' WHERE project_id=$projectId", { projectId });
    expect(() => capability.revalidateAccess()).toThrow(/Project Config|revision/i);
    db.close();
  });

  it('rejects unclaimed or cross-project planning capabilities', () => {
    const { db, requestId, service, options } = fixture(false);
    const run = prepareRequestInTransaction(db, service, options, (tx, runId) => {
      tx.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId WHERE id=$requestId", { runId, requestId });
    });
    expect(loadValidatedCapability(db, run.capabilityRef!).capability.requestId).toBe(requestId);
    const json = JSON.parse(db.get<{ capability_json: string }>('SELECT capability_json FROM agent_runs WHERE id=$id', { id: run.id })!.capability_json);
    json.projectId = randomUUID();
    db.run('UPDATE agent_runs SET capability_json=$json WHERE id=$id', { json: JSON.stringify(json), id: run.id });
    expect(() => loadValidatedCapability(db, run.capabilityRef!)).toThrow(/project|binding/i);
    db.close();
  });

  it('rejects a foreign workspace and disabled onboarding before persistence', () => {
    const { db, projectId, service, options } = fixture(false);
    const foreign = mkdtempSync(join(tmpdir(), 'ebb-planning-foreign-'));
    roots.push(foreign);
    expect(() => service.prepareRun(testContextOptions({ ...options, capability: { workspace: foreign } }))).toThrow(/workspace|repository/i);
    db.run("UPDATE onboarding_configs SET status='PROPOSED' WHERE project_id=$id", { id: projectId });
    expect(() => service.prepareRun(testContextOptions(options))).toThrow(/onboarding|project/i);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_runs')?.count).toBe(0);
    db.close();
  });

  it('binds pre-approval PM/Architect Runs to the exact planning request with read-only tools', () => {
    const { db, requestId, projectId, root, service, options } = fixture(false);
    const coordinatorRunId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,started_at,ended_at) VALUES($id,'coordinator','default','test','COMPLETED',$now,$now)", { id: coordinatorRunId, now });
    db.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId,planning_decisions_required=1 WHERE id=$requestId", { runId: coordinatorRunId, requestId });
    const pmOptions = { ...options, role: 'product_manager' as const, triggerReason: 'planning-request-role' as const };
    const pm = prepareRequestInTransaction(db, service, pmOptions, (tx, runId) => {
      tx.run("INSERT INTO planning_request_role_runs(request_id,role,run_id,created_at) VALUES($requestId,'product_manager',$runId,$now)", { requestId, runId, now });
    });

    const capability = loadValidatedCapability(db, pm.capabilityRef!);
    expect(pm.taskId).toBeNull();
    expect(pm.epicId).toBeNull();
    expect(capability.capability.requestId).toBe(requestId);
    expect(capability.capability.projectId).toBe(projectId);
    expect(capability.capability.workspace).toBe(root);
    expect(capability.capability.allowedTools).toEqual(['workspace.read', 'workspace.search', 'submit_result']);

    const architectOptions = { ...options, role: 'architect' as const, triggerReason: 'planning-request-role' as const };
    const architect = prepareRequestInTransaction(db, service, architectOptions, (tx, runId) => {
      tx.run("INSERT INTO planning_request_role_runs(request_id,role,run_id,created_at) VALUES($requestId,'architect',$runId,$now)", { requestId, runId, now });
    });
    expect(loadValidatedCapability(db, architect.capabilityRef!).capability.allowedTools).toEqual(['workspace.read', 'workspace.search', 'submit_result']);
    expect(() => service.prepareRun(testContextOptions({ ...options, role: 'product_manager', triggerReason: 'planning-request' } as StartRunOptions))).toThrow(/request planning run binding/i);
    db.close();
  });

  it('binds Epic-level Runs only to the verified managed Epic worktree journal', () => {
    const { db, projectId, root, service } = fixture(false);
    const epicId = randomUUID();
    const worktreeId = `epic:${epicId}`;
    const epicWorktree = join(root, `epic-${epicId}`);
    mkdirSync(epicWorktree);
    const now = new Date().toISOString();
    const branch = 'epic/EPIC-1';
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','Epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repo,$path,$branch,$now)", { id: worktreeId, repo: root, path: epicWorktree, branch, now });
    db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$repo,$branch,$worktreeId,'main',$now,$now)", { id: randomUUID(), repo: root, branch, worktreeId, now });

    const epicOptions = { taskId: null, epicId, role: 'architect', model: 'test', triggerReason: 'epic-architecture_review', contextVersion: '1', outputSchemaVersion: '1', capability: { workspace: epicWorktree, allowedTools: ['workspace.read', 'submit_result'] } } satisfies StartRunOptions;
    const run = service.prepareRun(testContextOptions(epicOptions));
    db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,status,created_at) VALUES($id,$epicId,NULL,'architecture_review','architect',$runId,'RUNNING',$now)", { id: randomUUID(), epicId, runId: run.id, now });

    const capability = loadValidatedCapability(db, run.capabilityRef!);
    expect(run.taskId).toBeNull();
    expect(run.epicId).toBe(epicId);
    expect(capability.capability.epicId).toBe(epicId);
    expect(capability.capability.workspace).toBe(epicWorktree);

    db.run("UPDATE worktrees SET branch='epic/EPIC-OTHER' WHERE id=$id", { id: worktreeId });
    expect(() => capability.revalidateAccess()).toThrow(/Epic worktree/i);
    expect(() => service.prepareRun(testContextOptions({ ...epicOptions, capability: { workspace: root, allowedTools: ['workspace.read', 'submit_result'] } }))).toThrow(/verified managed Epic worktree/i);
    db.close();
  });
});

function testContextOptions(options: StartRunOptions): StartRunOptions {
  const input = testContextInput(options);
  return { ...options, prompt: input.prompt, contextInput: input } as StartRunOptions;
}

function prepareRequestInTransaction(
  database: import('../../../src/platform/database/database.js').Database,
  service: RunService,
  options: StartRunOptions,
  bind: (tx: DatabaseTx, runId: string) => void,
) {
  const input = testContextInput(options);
  const preparedContext = testPreparedContext(input.prompt, input.role, input.subject);
  return database.transaction((tx) => service.prepareRunInTransaction(
    tx,
    { ...options, prompt: preparedContext.finalPrompt, contextInput: input },
    preparedContext,
    (runId) => bind(tx, runId),
  ));
}

function testContextInput(options: StartRunOptions) {
  const workspace = options.capability?.workspace ?? 'test-workspace';
  return createRunContextInput(options, {
    prompt: 'test caller prompt', roleInputs: {},
    workspaceIdentity: { repository: workspace, workspace, worktree: null },
    targetHead: null, targetBranch: null,
  });
}

function testPreparedContext(
  finalPrompt: string,
  role: string,
  subject: PreparedRunContext['subject'],
): PreparedRunContext {
  return {
    finalPrompt, subject, role: role as PreparedRunContext['role'], contractDigest: null, items: [],
    contextBuilderVersion: '1.0.0', promptHash: digestRunPromptBytesV1(new TextEncoder().encode(finalPrompt)),
    contextHash: 'b'.repeat(64), initialTokenSize: null, workspaceFingerprint: 'c'.repeat(64),
  };
}
