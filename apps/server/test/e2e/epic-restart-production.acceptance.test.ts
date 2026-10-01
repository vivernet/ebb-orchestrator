import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { EpicOrchestrator } from "../../src/modules/planning/epic-orchestrator.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { MergeService } from "../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../src/modules/git/integration-service.js";
import { TaskWorkspaceProvisioner } from "../../src/modules/git/task-workspace-provisioner.js";
import { EpicWorkspaceProvisioner } from "../../src/modules/git/epic-workspace-provisioner.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import type { Database } from "../../src/platform/database/database.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const serverFixture = resolve(import.meta.dirname, "fixtures/crash-recovery-server.mjs");
const shutdownMessage = "ebb-v1-crash-recovery:shutdown";
const productionChildEnvironmentAllowlist = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
] as const;

interface ProductionChild {
  process: ChildProcess;
  output: string;
}

interface StoredPhase {
  id: string;
  agent_run_id: string;
  task_id: string | null;
  phase: string;
  role: string;
  status: string;
  validated: number;
}

async function commitTaskFixtureChange(database: Database, runId: string, taskId: string): Promise<void> {
  const row = database.get<{ capability_json: string | null }>("SELECT capability_json FROM agent_runs WHERE id=$runId", { runId });
  let workspace: string | undefined;
  try {
    const capability = row?.capability_json ? JSON.parse(row.capability_json) as { workspace?: unknown } : undefined;
    if (typeof capability?.workspace === "string") workspace = capability.workspace;
  } catch { /* fail closed below */ }
  if (!workspace) throw new Error(`Developer run ${runId} has no persisted workspace`);
  const file = `fixture-${taskId}.txt`;
  await writeFile(join(workspace, file), `deterministic Task commit for ${taskId}\n`);
  const git = new GitCli();
  await git.run(workspace, ["add", file]);
  const commit = await git.run(workspace, ["commit", "-m", `seed Task integration fixture ${taskId}`]);
  if (commit.exitCode !== 0) throw new Error(`Could not create Task fixture commit: ${commit.stderr}`);
}

type CheckpointRequest = {
  phase: string;
  role: string;
  taskId?: string;
  integration?: { id: string; expected_target_sha: string; source_sha: string };
};

function createProductionChildEnvironment(
  home: string,
  port: number,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const allowedName of productionChildEnvironmentAllowlist) {
    const inheritedName = Object.keys(inherited).find((name) => name.toUpperCase() === allowedName.toUpperCase());
    const value = inheritedName ? inherited[inheritedName] : undefined;
    if (value !== undefined) environment[allowedName] = value;
  }
  environment.EBB_ORCHESTRATOR_HOME = home;
  environment.PORT = String(port);
  return environment;
}

/** Детеминированный runtime используется только для подготовки checkpoint до production restart. */
class CheckpointFixtureRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  readonly calls: Array<{ phase: string; role: string; taskId?: string }> = [];
  private readonly requests = new Map<string, { run: AgentRun; request: CheckpointRequest }>();
  private readonly completion: DatabaseCompletionStore;
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
    this.completion = new DatabaseCompletionStore(database);
  }

  async startRun(run: AgentRun): Promise<void> {
    const phase = this.database.get<{ phase: string; task_id: string | null }>(
      "SELECT phase,task_id FROM orchestration_phase_runs WHERE agent_run_id=$runId",
      { runId: run.id },
    );
    const integration = this.database.get<{ id: string; expected_target_sha: string; source_sha: string }>(
      "SELECT id,expected_target_sha,source_sha FROM integration_attempts WHERE integration_run_id=$runId",
      { runId: run.id },
    );
    let request: CheckpointRequest;
    try {
      request = JSON.parse((run as AgentRun & { prompt?: string }).prompt ?? "{}") as typeof request;
    } catch {
      request = {
        phase: phase?.phase ?? "integration",
        role: run.role.toLowerCase(),
        ...(phase?.task_id ? { taskId: phase.task_id } : {}),
        ...(integration ? { integration } : {}),
      };
    }
    this.requests.set(run.id, { run, request });
    this.calls.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  async collectResult(runId: string): Promise<RunOutcome> {
    const stored = this.requests.get(runId);
    if (!stored) throw new Error(`Fixture runtime has no run ${runId}`);
    this.active--;
    const { run, request } = stored;
    const common = { version: "1.0", summary: request.phase };
    if (request.role === "developer" && request.taskId) {
      await commitTaskFixtureChange(this.database, runId, request.taskId);
    }
    const output = request.role === "coordinator"
      ? { ...common, operation: "PLAN", classification: "EPIC" }
      : request.role === "product_manager"
        ? { ...common, outcome: "PRODUCT_DEFINITION", goal: "Restart acceptance" }
        : request.role === "architect"
          ? { ...common, outcome: "DESIGN", architectureReviewRequired: true }
          : request.role === "developer"
            ? { ...common, outcome: "COMPLETED" }
            : request.role === "reviewer"
              ? { ...common, outcome: "PASS", independent: true }
              : request.role === "integration"
                ? (() => {
                    const attempt = request.integration;
                    if (!attempt) throw new Error(`No persisted integration attempt for run ${runId}`);
                    return {
                      ...common,
                      outcome: "PASS",
                      baseSha: attempt.expected_target_sha,
                      sourceSha: attempt.source_sha,
                      provenance: [`integration_attempt:${attempt.id}`],
                      evidence: ["Verified the prepared source SHA in the integration worktree"],
                    };
                  })()
              : request.role === "integration"
                ? (() => {
                    const attempt = request.integration;
                    if (!attempt) throw new Error(`No persisted integration attempt for run ${runId}`);
                    return {
                      ...common,
                      outcome: "PASS",
                      baseSha: attempt.expected_target_sha,
                      sourceSha: attempt.source_sha,
                      provenance: [`integration_attempt:${attempt.id}`],
                      evidence: ["Verified the prepared source SHA in the integration worktree"],
                    };
                  })()
                : { ...common, outcome: "PASS", evidence: [`${request.phase}-checkpoint`] };
    if (!run.capabilityRef) throw new Error(`Fixture run ${runId} has no completion capability`);
    const accepted = await this.completion.accept(run.capabilityRef, { runId, role: run.role, output });
    if (!accepted) throw new Error(`Fixture result for ${runId} was rejected`);
    return {
      success: true,
      exitCode: 0,
      output: JSON.stringify(output),
      validatedSubmission: true,
      diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    };
  }

  async runResult(runId: string): Promise<RunOutcome> { return this.collectResult(runId); }
  async resumeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  async inspectRun(): Promise<AgentRun> { throw new Error("Fixture runtime does not inspect runs"); }
  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0.25 };
  }
  async healthCheck(): Promise<boolean> { return true; }
}

async function reserveLoopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const address = listener.address() as AddressInfo | null;
  if (!address) throw new Error("Could not reserve a loopback port");
  await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function launchProductionChild(home: string, port: number, bootstrap: boolean): ProductionChild {
  const environment = createProductionChildEnvironment(home, port);
  const child = spawn(process.execPath, [serverFixture, ...(bootstrap ? ["--bootstrap-local-user-stdin"] : [])], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  if (bootstrap) {
    const password = randomBytes(32).toString("base64url");
    const payload = Buffer.from(`${password}\n${password}\n`, "utf8");
    child.stdin?.end(payload);
    payload.fill(0);
  } else {
    child.stdin?.end();
  }
  return { process: child, get output() { return output; } };
}

async function waitForExit(child: ProductionChild, timeoutMs: number): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const onExit = () => { clearTimeout(timer); resolveExit(); };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      reject(new Error(`production process did not exit; output tail: ${child.output.slice(-2000)}`));
    }, timeoutMs);
    child.process.once("exit", onExit);
  });
}

async function waitForReady(child: ProductionChild, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error(`production process exited before READY; output tail: ${child.output.slice(-3000)}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
    if (response?.ok) {
      expect((await response.json()).lifecycle).toBe("READY");
      expect(child.output).toContain("status: READY");
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`production process did not reach READY; output tail: ${child.output.slice(-3000)}`);
}

async function stopProductionChild(child: ProductionChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    expect(child.process.exitCode).toBe(0);
    expect(child.output).toContain("shutdown complete");
    return;
  }
  await new Promise<void>((resolveSend, reject) => {
    child.process.send(shutdownMessage, (error) => error ? reject(error) : resolveSend());
  });
  await waitForExit(child, 20_000);
  expect(child.process.exitCode).toBe(0);
  expect(child.output).toContain("shutdown complete");
}

function snapshotPhases(database: Database, epicId: string): StoredPhase[] {
  return database.all<StoredPhase>(
    `SELECT id,agent_run_id,task_id,phase,role,status,validated
       FROM orchestration_phase_runs WHERE epic_id=$epicId ORDER BY task_id,phase`,
    { epicId },
  );
}

describe("Plan05 production process Epic restart acceptance", () => {
  let root = "";
  let database: Database | undefined;
  const children: ProductionChild[] = [];

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    try { database?.close(); } catch (error) { cleanupErrors.push(error); }
    database = undefined;
    const childrenToStop = children.splice(0);
    for (const child of childrenToStop) {
      try {
        await stopProductionChild(child);
      } catch (error) {
        cleanupErrors.push(error);
        child.process.kill("SIGTERM");
        try {
          await waitForExit(child, 10_000);
        } catch (termError) {
          cleanupErrors.push(termError);
          child.process.kill("SIGKILL");
          try { await waitForExit(child, 10_000); }
          catch (killError) { cleanupErrors.push(killError); }
        }
      }
    }
    const survivors = childrenToStop.filter((child) => child.process.exitCode === null && child.process.signalCode === null);
    if (survivors.length > 0) {
      throw new AggregateError(cleanupErrors, `production child teardown did not complete; isolated home retained at ${root}`);
    }
    if (root) {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      expect(existsSync(root)).toBe(false);
    }
    root = "";
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "production child teardown required forced cleanup or exited unexpectedly");
  });

  it("does not pass inherited credentials or provider configuration to the production child", () => {
    const environment = createProductionChildEnvironment("C:/disposable/home", 43127, {
      PATH: "safe-system-path",
      SystemRoot: "C:/Windows",
      USERPROFILE: "C:/Users/acceptance",
      APPDATA: "C:/Users/acceptance/AppData/Roaming",
      TEMP: "C:/Temp",
      HOME: "/home/acceptance",
      DATABASE_URL: "sqlite://user:password@private.example/database",
      REGISTRY_AUTH_FILE: "C:/Users/acceptance/.docker/config.json",
      CUSTOM_RUNTIME_CONFIG: "private-value",
      API_PASSWORD: "must-not-inherit",
      DATABASE_TOKEN: "must-not-inherit",
      CUSTOM_SECRET_BUNDLE: "must-not-inherit",
      DEPLOY_CREDENTIAL: "must-not-inherit",
      OPENAI_API_KEY: "must-not-inherit",
      ANTHROPIC_API_KEY: "must-not-inherit",
      GITHUB_TOKEN: "must-not-inherit",
      GH_TOKEN: "must-not-inherit",
      AWS_SECRET_ACCESS_KEY: "must-not-inherit",
      EBB_HERMES_PROVIDER_SECRET_NAME: "must-not-inherit",
      HERMES_HOME: "must-not-inherit",
      EBB_ORCHESTRATOR_HOME: "old-home",
      PORT: "old-port",
    });

    for (const key of [
      "SAFE_TEST_SETTING", "DATABASE_URL", "REGISTRY_AUTH_FILE", "CUSTOM_RUNTIME_CONFIG",
      "API_PASSWORD", "DATABASE_TOKEN", "CUSTOM_SECRET_BUNDLE", "DEPLOY_CREDENTIAL",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY", "EBB_HERMES_PROVIDER_SECRET_NAME", "HERMES_HOME",
    ]) expect(environment[key]).toBeUndefined();
    expect(environment).toMatchObject({
      PATH: "safe-system-path",
      SystemRoot: "C:/Windows",
      USERPROFILE: "C:/Users/acceptance",
      APPDATA: "C:/Users/acceptance/AppData/Roaming",
      TEMP: "C:/Temp",
      HOME: "/home/acceptance",
      EBB_ORCHESTRATOR_HOME: "C:/disposable/home",
      PORT: "43127",
    });
    expect(Object.keys(environment).sort()).toEqual([
      "APPDATA", "EBB_ORCHESTRATOR_HOME", "HOME", "PATH", "PORT", "SystemRoot", "TEMP", "USERPROFILE",
    ].sort());
  });

  it("fails teardown when a production child has exited unexpectedly", async () => {
    const processChild = spawn(process.execPath, ["-e", "process.exit(7)"], {
      shell: false,
      stdio: "ignore",
    });
    await new Promise<void>((resolveExit) => processChild.once("exit", () => resolveExit()));
    await expect(stopProductionChild({ process: processChild, output: "" })).rejects.toThrow();
  });

  it("restarts production main, resumes only approved Epic to FINAL_APPROVAL, and preserves completed child work", async () => {
    root = await mkdtemp(join(tmpdir(), "ebb-plan05-epic-restart-"));
    const home = join(root, ".ebb-orchestrator");
    const repoPath = join(root, "repository");
    await mkdir(repoPath, { recursive: true });
    const git = new GitCli();
    await git.run(repoPath, ["init", "--initial-branch=master"]);
    await git.run(repoPath, ["config", "user.email", "acceptance@example.invalid"]);
    await git.run(repoPath, ["config", "user.name", "Acceptance Fixture"]);
    await writeFile(join(repoPath, "README.md"), "# Disposable Plan05 acceptance repository\n");
    await git.run(repoPath, ["add", "README.md"]);
    await git.run(repoPath, ["commit", "-m", "initial acceptance fixture"]);

    const port = await reserveLoopbackPort();
    const homePaths = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: home }, process.platform === "win32" ? "win32" : "linux");
    const epicWorktreeRoot = join(homePaths.worktrees, "epics");
    const taskWorktreeRoot = join(homePaths.worktrees, "tasks");
    const firstProcess = launchProductionChild(home, port, true);
    children.push(firstProcess);
    await waitForReady(firstProcess, port);

    database = createSqliteDatabase(homePaths.database);
    const approvals = new ApprovalService(database);
    const onboarding = new OnboardingService(database, approvals);
    const draft = await onboarding.discoverAndCreateDraft(repoPath);
    onboarding.requestApproval(draft.projectId, {
      defaultBranch: "master",
      workflow: "standard",
      roles: ["developer", "reviewer", "qa", "integration"],
      guidelines: ["Use the disposable acceptance repository."],
    });
    onboarding.approve(draft.projectId);
    onboarding.activate(draft.projectId);
    seedApprovedProjectConfig(database, draft.projectId, "master");
    database.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000,0,0)", { projectId: draft.projectId });

    const planning = new PlanningService(database);
    const workflowRegistry = new WorkflowRegistry();
    for (const template of Object.values(templates)) workflowRegistry.register(template);
    const fixtureRuntime = new CheckpointFixtureRuntime(database);
    const fixtureEpicProvisioner = new EpicWorkspaceProvisioner({ database, worktreeDir: epicWorktreeRoot, git });
    const fixtureTaskProvisioner = new TaskWorkspaceProvisioner({
      database,
      worktreeManager: new WorktreeManager({ db: database, git, worktreeDir: taskWorktreeRoot }),
    });
    const fixtureOrchestrator = new EpicOrchestrator(
      database,
      new WorkflowEngine(database, workflowRegistry),
      planning,
      new RunService(database, fixtureRuntime),
      new MergeService({ database, repoPath, targetBranch: "master" }),
      new SchedulerService(database),
      {
        epicWorkspaceProvisioner: fixtureEpicProvisioner,
        taskWorkspaceProvisioner: fixtureTaskProvisioner,
        integrationWorktreeRoot: join(homePaths.worktrees, "integrations"),
        integrationServiceFactory: ({ worktreeRoot, integrationRunId }) => new IntegrationService({
          database: database!,
          worktreeDir: worktreeRoot,
          provenanceDatabasePath: homePaths.database,
          integrationRunId,
        }),
      },
    );
    const approvedPlan = await fixtureOrchestrator.start({
      projectId: draft.projectId,
      requestedBy: "plan05-restart-acceptance",
      includeProductManager: false,
      includeArchitect: false,
      tasks: [
        { ref: "task_foundation", title: "Foundation", acceptanceCriteria: ["Foundation phase is complete"], role: "developer", workflow: "standard" },
        { ref: "task_api", title: "API", acceptanceCriteria: ["API phase is complete"], dependsOn: ["task_foundation"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Restart acceptance Epic", goal: "Prove production restart recovery" },
    });
    const unapprovedPlan = await fixtureOrchestrator.start({
      projectId: draft.projectId,
      requestedBy: "plan05-restart-control",
      includeProductManager: false,
      includeArchitect: false,
      tasks: [{ ref: "task_control", title: "Unapproved control", acceptanceCriteria: ["Must not run"], role: "developer", workflow: "standard" }],
      epic: { title: "Unapproved control Epic", goal: "Remain pending" },
    });
    expect(approvedPlan.status).toBe("PENDING");
    expect(unapprovedPlan.status).toBe("PENDING");

    // Планы и domain rows создаются штатными сервисами. Fake runtime подготавливает
    // завершённые durable checkpoints; после этого production child используется только
    // для реального process restart и штатного startup recovery.
    planning.approvePlan(approvedPlan.id, "acceptance-user");
    const materializedEpicId = database.get<{ epic_id: string }>("SELECT epic_id FROM planning_plans WHERE id=$id", { id: approvedPlan.id })?.epic_id;
    if (!materializedEpicId) throw new Error("Approved acceptance plan did not materialize an Epic");
    const epicWorkspace = await fixtureEpicProvisioner.provisionForEpic(materializedEpicId);
    await writeFile(join(epicWorkspace.path, "epic-fixture.txt"), "deterministic Epic source commit\n");
    await git.run(epicWorkspace.path, ["add", "epic-fixture.txt"]);
    const epicSeedCommit = await git.run(epicWorkspace.path, ["commit", "-m", "seed Epic integration fixture"]);
    if (epicSeedCommit.exitCode !== 0) throw new Error(`Could not create Epic fixture commit: ${epicSeedCommit.stderr}`);
    const seeded = await fixtureOrchestrator.approveAndRun(approvedPlan.id, "acceptance-user");
    expect(seeded.childStatuses).toEqual(["INTEGRATED_INTO_EPIC", "INTEGRATED_INTO_EPIC"]);
    const epicId = seeded.epicId;
    expect(epicId).toBe(materializedEpicId);
    const taskRows = database.all<{ id: string; status: string }>("SELECT id,status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId });
    const taskIds = taskRows.map(({ id }) => id);
    expect(taskIds).toHaveLength(2);
    expect(fixtureRuntime.calls.some((call) => call.taskId !== undefined)).toBe(true);

    const finalApprovalId = seeded.finalApprovalId;
    expect(finalApprovalId).toBeDefined();
    approvals.reject(finalApprovalId!, "acceptance-fixture", "Recreate the crash window before final approval creation.");
    database.run("UPDATE epic_orchestrations SET stage='INTEGRATION',final_approval_id=NULL,updated_at=$at WHERE epic_id=$epicId", { epicId, at: new Date().toISOString() });
    database.close();
    database = undefined;

    // Production task provisioning must see real verified worktrees on recovery.
    database = createSqliteDatabase(homePaths.database);
    await new EpicWorkspaceProvisioner({ database, worktreeDir: epicWorktreeRoot, git }).provisionForEpic(epicId);
    await new TaskWorkspaceProvisioner({
      database,
      worktreeManager: new WorktreeManager({ db: database, git, worktreeDir: taskWorktreeRoot }),
    }).provisionForEpic(epicId);

    const phaseRowsBefore = snapshotPhases(database, epicId);
    const runIdsBefore = database.all<{ id: string; status: string }>(
      "SELECT id,status FROM agent_runs WHERE epic_id=$epicId ORDER BY id", { epicId },
    );
    const phaseIdsBefore = phaseRowsBefore.map(({ id }) => id);
    expect(phaseRowsBefore).toHaveLength(12);
    expect(phaseRowsBefore.every((phase) => phase.status === "COMPLETED" && phase.validated === 1)).toBe(true);
    expect(database.get<{ status: string; epic_id: string | null }>("SELECT status,epic_id FROM planning_plans WHERE id=$id", { id: unapprovedPlan.id })).toEqual({ status: "PENDING", epic_id: null });
    const phaseControl = phaseRowsBefore.map(({ phase, role, task_id }) => `${task_id ?? "epic"}:${phase}:${role}`);
    expect(phaseControl.filter((phase) => phase.includes("child_task:")).length).toBe(2);

    // The first server process was READY before this approved Epic recovery checkpoint existed.
    expect(firstProcess.process.kill("SIGKILL")).toBe(true);
    await waitForExit(firstProcess, 20_000);
    expect(firstProcess.process.exitCode !== null || firstProcess.process.signalCode !== null).toBe(true);
    children.splice(children.indexOf(firstProcess), 1);
    const lockPath = join(home, "orchestrator.lock");
    expect(await readFile(lockPath, "utf8")).toContain(`v1:${firstProcess.process.pid}:`);
    await rm(lockPath);

    const restartedProcess = launchProductionChild(home, port, false);
    children.push(restartedProcess);
    await waitForReady(restartedProcess, port);

    const persisted = database;
    const orchestration = persisted.get<{ plan_id: string; stage: string; final_approval_id: string | null }>(
      "SELECT plan_id,stage,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId },
    );
    expect(orchestration).toMatchObject({ plan_id: approvedPlan.id, stage: "FINAL_APPROVAL" });
    expect(orchestration?.final_approval_id).toBeTruthy();
    expect(persisted.get<{ status: string; epic_id: string }>("SELECT status,epic_id FROM planning_plans WHERE id=$id", { id: approvedPlan.id })).toEqual({ status: "APPROVED", epic_id: epicId });
    expect(persisted.get<{ stage: string }>("SELECT stage FROM epic_orchestrations WHERE plan_id=$id", { id: unapprovedPlan.id })).toBeUndefined();
    expect(persisted.get<{ status: string; epic_id: string | null }>("SELECT status,epic_id FROM planning_plans WHERE id=$id", { id: unapprovedPlan.id })).toEqual({ status: "PENDING", epic_id: null });
    expect(persisted.all<{ id: string; status: string }>("SELECT id,status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId })).toEqual(taskRows);
    expect(snapshotPhases(persisted, epicId).map(({ id }) => id)).toEqual(phaseIdsBefore);
    expect(snapshotPhases(persisted, epicId)).toEqual(phaseRowsBefore);
    expect(persisted.all<{ id: string; status: string }>("SELECT id,status FROM agent_runs WHERE epic_id=$epicId ORDER BY id", { epicId })).toEqual(runIdsBefore);
    expect(persisted.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NOT NULL", { epicId })?.count).toBe(8);
    expect(persisted.get<{ count: number }>("SELECT COUNT(*) AS count FROM approvals WHERE type='FINAL_MERGE' AND subject_id=$epicId AND subject_type='EPIC' AND status='PENDING'", { epicId })?.count).toBe(1);
    expect(persisted.get<{ status: string }>("SELECT status FROM approvals WHERE id=$id", { id: orchestration!.final_approval_id })?.status).toBe("PENDING");
    expect(persisted.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$epicId", { epicId })?.count).toBe(runIdsBefore.length);

    console.log(
      `[plan05-epic-restart] PASS epicId=${epicId} planId=${approvedPlan.id} ` +
      `taskIds=${taskIds.join(",")} runs=${runIdsBefore.length} phases=${phaseIdsBefore.length} ` +
      `stage=${orchestration?.stage} finalApproval=PENDING controlPlan=PENDING provider=NOT_INVOKED`,
    );

    await stopProductionChild(restartedProcess);
    children.splice(children.indexOf(restartedProcess), 1);
    expect(phaseControl).toContain(`${taskIds[0]}:child_task:developer`);
    expect(phaseControl).toContain(`${taskIds[1]}:child_task:developer`);
  }, 240_000);
});
