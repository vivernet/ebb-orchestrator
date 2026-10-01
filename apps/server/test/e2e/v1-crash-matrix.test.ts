import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { appendOutboxEvent } from "../../src/platform/events/outbox-repository.js";
import { DomainEvent } from "../../src/platform/events/domain-event.js";
import { createRunContextInput, RunService, taskDeveloperPrompt } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import { BudgetService } from "../../src/modules/usage/budget-service.js";
import { GitHubSyncService, SqliteSyncState } from "../../src/modules/github/github-sync-service.js";
import type { GitHosting, PullRequest } from "../../src/modules/github/git-hosting.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { GitReconciler } from "../../src/modules/git/git-reconciler.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { WorktreeRepository } from "../../src/modules/git/worktree-repository.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const crashServerEntry = resolve(import.meta.dirname, "fixtures/crash-recovery-server.mjs");
const crashShutdownMessage = "ebb-v1-crash-recovery:shutdown";

interface ProductionChild {
  process: ChildProcess;
  output: string;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function launchProductionChild(home: string, port: number, bootstrap: boolean): ProductionChild {
  const processHandle = spawn(process.execPath, [crashServerEntry, ...(bootstrap ? ["--bootstrap-local-user-stdin"] : [])], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: String(port) },
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let output = "";
  processHandle.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  processHandle.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  if (bootstrap) {
    const password = randomBytes(32).toString("base64url");
    const passwordPayload = Buffer.from(`${password}\n${password}\n`, "utf8");
    processHandle.stdin?.end(passwordPayload);
    passwordPayload.fill(0);
  } else {
    processHandle.stdin?.end();
  }
  return { process: processHandle, get output() { return output; } };
}

async function waitForProductionExit(child: ProductionChild, timeoutMs: number): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const onExit = () => { clearTimeout(timer); resolveExit(); };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      reject(new Error("production test child did not exit within timeout"));
    }, timeoutMs);
    child.process.once("exit", onExit);
  });
}

async function waitForProductionReady(child: ProductionChild, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`production test child exited before READY: ${child.output.slice(-2000)}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
    if (response?.ok) {
      expect((await response.json()).lifecycle).toBe("READY");
      expect(child.output).toContain("status: READY");
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("production test child did not reach READY within timeout");
}

async function stopProductionChild(child: ProductionChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveSend, reject) => {
    child.process.send(crashShutdownMessage, (error) => error ? reject(error) : resolveSend());
  });
  await waitForProductionExit(child, 15_000);
  expect(child.process.exitCode).toBe(0);
  expect(child.output).toContain("shutdown complete");
}

describe('v1 production recovery paths', () => {
  let tempDirectory: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  async function openDatabase(): Promise<Database> {
    tempDirectory ??= await mkdtemp(join(tmpdir(), 'orchestrator-v1-recovery-'));
    const database = createSqliteDatabase(join(tempDirectory, 'state.db'));
    runMigrations(database, loadTestMigrations());
    return database;
  }

  function seedRunSubject(database: Database, taskId: string): void {
    const projectId = randomUUID();
    const now = new Date().toISOString();
    database.run(
      "INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'recovery-run','Recovery Run','ACTIVE',$now,$now)",
      { id: projectId, now },
    );
    database.run(
      `INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,required,created_at,updated_at)
       VALUES ($id,$projectId,'TASK-RECOVERY','Recovery task','READY',$contract,1,$now,$now)`,
      {
        id: taskId,
        projectId,
        contract: JSON.stringify({ version: 1, goal: "Recovery task", context: "Crash recovery fixture", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }),
        now,
      },
    );
    seedApprovedProjectConfig(database, projectId);
  }

  function recoveryRunOptions(taskId: string, workspacePath: string): StartRunOptions {
    const prompt = taskDeveloperPrompt();
    const options = {
      runId: randomUUID(), role: 'developer', model: 'test-model', taskId, epicId: null,
      triggerReason: 'task-assignment', contextVersion: '1', outputSchemaVersion: '1',
      capability: { workspace: workspacePath },
    } satisfies StartRunOptions;
    return {
      ...options,
      prompt,
      contextInput: createRunContextInput(options, {
        prompt,
        workspaceIdentity: { repository: workspacePath, workspace: workspacePath, worktree: taskId },
        targetHead: null,
        targetBranch: null,
      }),
    };
  }

  it('acknowledges a delivered outbox event after restart without repeating its consumer', async () => {
    db = await openDatabase();
    const event = DomainEvent.create({ type: 'recovery.test', payload: { id: 'one' } });
    db.transaction((tx) => appendOutboxEvent(tx, event));

    // Models the durable state after a consumer has completed and recorded its receipt,
    // but the process stopped before marking the outbox row processed.
    db.run(
      'INSERT INTO processed_events (consumer_name, event_id, processed_at) VALUES ($consumer, $event, $at)',
      { consumer: 'recovery-consumer', event: event.id, at: new Date().toISOString() },
    );
    db.close();
    db = await openDatabase();

    const handler = vi.fn();
    const bus = new EventBus();
    bus.subscribe(event.type, 'recovery-consumer', handler);
    expect(await new EventDispatcher(db, bus).dispatchBatch(10)).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM outbox_events WHERE id = $id', { id: event.id },
    )?.processed_at).toEqual(expect.any(String));
  });

  it('marks a durable in-progress run interrupted and clears its capability after restart', async () => {
    db = await openDatabase();
    const taskId = randomUUID();
    seedRunSubject(db, taskId);
    const runService = new RunService(db, new FakeAgentRuntime());
    const run = runService.prepareRun(recoveryRunOptions(taskId, tempDirectory!));
    db.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: run.id });
    db.close();
    db = await openDatabase();

    expect(new RunService(db, new FakeAgentRuntime()).reconcileInterruptedRuns()).toBe(1);
    expect(db.get<{ status: string; capability_ref: string | null }>(
      'SELECT status, capability_ref FROM agent_runs WHERE id=$id', { id: run.id },
    )).toEqual({ status: 'FAILED', capability_ref: null });
  });

  it('releases a durable orphaned budget reservation after restart', async () => {
    db = await openDatabase();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
       VALUES ($id, $name, $display_name, 'ACTIVE', $now, $now)`,
      { id: projectId, name: 'recovery-budget', display_name: 'Recovery budget', now },
    );
    db.run(
      `INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at)
       VALUES ($id, 'project', $scope_id, 10, 8, 'hard', $now, $now)`,
      { id: randomUUID(), scope_id: projectId, now },
    );
    const reserved = new BudgetService(db).reserve({
      projectId, estimateCost: 3, role: 'developer', model: 'test-model', triggerReason: 'DEVELOPMENT',
    });
    expect(reserved.decision).toBe('ALLOW');
    expect(db.get<{ reserved_cost: number }>(
      'SELECT reserved_cost FROM budget_configs WHERE scope_id=$id', { id: projectId },
    )?.reserved_cost).toBe(3);
    db.close();
    db = await openDatabase();

    expect(new BudgetService(db).cleanupStaleReservations([])).toEqual({ released: 1 });
    expect(db.get<{ status: string }>(
      'SELECT status FROM budget_reservations WHERE id=$id', { id: reserved.reservationId },
    )?.status).toBe('RELEASED');
    expect(db.get<{ reserved_cost: number }>(
      'SELECT reserved_cost FROM budget_configs WHERE scope_id=$id', { id: projectId },
    )?.reserved_cost).toBe(0);
  });

  it('preserves committed task code and branch across a worktree manager restart', async () => {
    db = await openDatabase();
    tempDirectory ??= await mkdtemp(join(tmpdir(), 'orchestrator-v1-recovery-'));
    const repoPath = join(tempDirectory, 'repo');
    const worktreeRoot = join(tempDirectory, 'managed-worktrees');
    await mkdir(repoPath);
    const git = new GitCli();
    await git.run(repoPath, ['init', '--initial-branch=master']);
    await git.run(repoPath, ['config', 'user.email', 'test@example.com']);
    await git.run(repoPath, ['config', 'user.name', 'Test User']);
    await writeFile(join(repoPath, 'README.md'), '# Initial');
    await git.run(repoPath, ['add', 'README.md']);
    await git.run(repoPath, ['commit', '-m', 'initial']);

    const taskId = 'recovery-branch';
    const workspace = await new WorktreeManager({ db: db!, worktreeDir: worktreeRoot })
      .createTaskWorkspace(taskId, repoPath, 'master');
    await writeFile(join(workspace.path, 'committed.txt'), 'committed task result');
    await git.run(workspace.path, ['add', 'committed.txt']);
    await git.run(workspace.path, ['commit', '-m', 'task result']);

    db!.close();
    db = await openDatabase();
    expect(new WorktreeRepository(db).findById(taskId)).toMatchObject({
      id: taskId, repoPath, path: workspace.path, branch: 'task/recovery-branch',
    });
    const branch = await git.run(repoPath, ['rev-parse', '--verify', '--end-of-options', 'task/recovery-branch']);
    const content = await readFile(join(workspace.path, 'committed.txt'), 'utf8');
    const reconciler = new GitReconciler();
    await reconciler.initialize(repoPath);
    const recovered = await reconciler.reconcile('task/recovery-branch', workspace.path);

    expect(branch.stdout.trim()).not.toBe('');
    expect(content).toBe('committed task result');
    expect(recovered.state).toBe('IN_SYNC');
  });

  it('releases a durable scheduler run reservation and resource lock after restart', async () => {
    db = await openDatabase();
    const projectId = randomUUID();
    const reservationId = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
       VALUES ($id, 'scheduler-recovery', 'Scheduler recovery', 'ACTIVE', $now, $now)`,
      { id: projectId, now },
    );
    db.run('INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($project,10,0,2)', { project: projectId });
    db.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('interrupted-run','reviewer','test','test','FAILED',0)");
    db.run(
      `INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id)
       VALUES($id,'RUN','interrupted-run',$project,'run:interrupted-run',$now,2,'RESERVED','reviewer','test','interrupted-run')`,
      { id: reservationId, project: projectId, now },
    );
    db.run(
      `INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at)
       VALUES('interrupted-run-resource',$reservation,$project,'run:interrupted-run',$now)`,
      { reservation: reservationId, project: projectId, now },
    );
    db.close();
    db = await openDatabase();

    expect(new SchedulerService(db).reconcile()).toEqual({
      releasedReservationIds: [reservationId], blockedReservationIds: [],
    });
    expect(db.get<{ status: string }>(
      'SELECT status FROM scheduler_reservations WHERE id=$id', { id: reservationId },
    )?.status).toBe('RELEASED');
    expect(db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id', { id: reservationId },
    )?.count).toBe(0);
    expect(db.get<{ reserved_cost: number }>(
      'SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$id', { id: projectId },
    )?.reserved_cost).toBe(0);
  });

  it('recovers an interrupted run after a killed production process and explicit stale-lock cleanup', async () => {
    tempDirectory ??= await mkdtemp(join(tmpdir(), 'orchestrator-v1-recovery-'));
    const home = join(tempDirectory, 'production-home');
    await mkdir(home);
    const port = await reserveLoopbackPort();
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const databasePath = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: home }, platform).database;
    let firstProcess: ProductionChild | undefined;
    let restartedProcess: ProductionChild | undefined;
    let restartRejected: ProductionChild | undefined;

    try {
      firstProcess = launchProductionChild(home, port, true);
      await waitForProductionReady(firstProcess, port);
      db = createSqliteDatabase(databasePath);
      const taskId = randomUUID();
      seedRunSubject(db, taskId);
      const run = new RunService(db, new FakeAgentRuntime()).prepareRun(recoveryRunOptions(taskId, home));
      db.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: run.id });
      db.close();
      db = undefined;

      expect(firstProcess.process.kill('SIGKILL')).toBe(true);
      await waitForProductionExit(firstProcess, 15_000);
      expect(firstProcess.process.exitCode !== null || firstProcess.process.signalCode !== null).toBe(true);

      const lockPath = join(home, 'orchestrator.lock');
      expect(existsSync(lockPath)).toBe(true);
      expect(await readFile(lockPath, 'utf8')).toContain(`v1:${firstProcess.process.pid}:`);
      restartRejected = launchProductionChild(home, port, false);
      await waitForProductionExit(restartRejected, 10_000);
      expect(restartRejected.process.exitCode).toBe(1);
      expect(restartRejected.output).toContain('Could not acquire the startup lock');

      await rm(lockPath);
      restartedProcess = launchProductionChild(home, port, false);
      await waitForProductionReady(restartedProcess, port);
      db = createSqliteDatabase(databasePath);
      expect(db.get<{ status: string; capability_ref: string | null }>(
        'SELECT status, capability_ref FROM agent_runs WHERE id=$id', { id: run.id },
      )).toEqual({ status: 'FAILED', capability_ref: null });
      db.close();
      db = undefined;
      await stopProductionChild(restartedProcess);
      restartedProcess = undefined;
    } finally {
      db?.close();
      db = undefined;
      for (const child of [firstProcess, restartRejected, restartedProcess]) {
        if (!child || child.process.exitCode !== null || child.process.signalCode !== null) continue;
        child.process.kill('SIGTERM');
        await waitForProductionExit(child, 15_000).catch(() => undefined);
      }
    }
  }, 180_000);

  it('finds the remote PR after local acknowledgement fails and does not create a duplicate', async () => {
    db = await openDatabase();
    let remotePullRequest: PullRequest | undefined;
    const hosting = {
      findPullRequest: vi.fn(async () => ({ status: 'OK' as const, value: remotePullRequest })),
      createPullRequest: vi.fn(async () => {
        remotePullRequest = { id: 987, number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', head: 'task/1', base: 'master' };
        return { status: 'OK' as const, value: remotePullRequest };
      }),
    } as unknown as GitHosting;
    const state = new SqliteSyncState(db);
    vi.spyOn(state, 'set').mockImplementation(() => { throw new Error('simulated interruption before local acknowledgement'); });

    await expect(new GitHubSyncService(hosting, state).ensurePullRequest(
      'o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' },
    )).rejects.toThrow('simulated interruption');
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
    db.close();
    db = await openDatabase();

    const recovered = await new GitHubSyncService(hosting, new SqliteSyncState(db)).ensurePullRequest(
      'o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' },
    );
    expect(recovered.status).toBe('SUCCEEDED');
    expect(recovered.pullRequest?.number).toBe(7);
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
  });
});
