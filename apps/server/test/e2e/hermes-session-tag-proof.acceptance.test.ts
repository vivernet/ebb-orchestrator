import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { ProjectConfigRepository } from "../../src/modules/projects/project-config-repository.js";
import { ProjectConfigService } from "../../src/modules/projects/project-config-service.js";
import { createRunContextInput, RunService } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { getRunProcessOwner, isCanonicalRunProcessStopEvidence, transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import type { Database } from "../../src/platform/database/database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../src/platform/process/process-inspector.js";
import type { ProcessScopeSupervisor } from "../../src/platform/process/run-scope-supervisor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import { parseProjectConfigYaml } from "../../src/platform/config/project-config.js";
import { loadTestMigrations } from "../helpers/migrations.js";

const EXPECTED_HERMES_VERSION = "Hermes Agent v0.21.5+4831.g02e4118 (2026.9.24) · upstream 02e41181";
const QUERY_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 500;
const POLL_LIMIT_MS = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidencePath = process.env.EBB_HERMES_SESSION_TAG_EVIDENCE_PATH
  ? resolve(process.env.EBB_HERMES_SESSION_TAG_EVIDENCE_PATH)
  : join(repositoryRoot, "temp", "hermes-session-tag-proof", "raw-cli-output.txt");

describe.skip("Hermes session source-tag live acceptance — NOT RUN until Task5B verifies Hermes-native per-Run auth", () => {
  let root = "";
  let database: Database | undefined;
  let runService: RunService | undefined;
  let supervisor: ProcessScopeSupervisor | undefined;
  let runId: string | undefined;
  let execution: Promise<unknown> | undefined;
  let executionSettled = false;
  let priorHome: string | undefined;
  let homeWasSet = false;
  const executor = new ProcessExecutor();

  afterEach(async () => {
    let cleanupFailure: unknown;
    const cleanupRunId = runId;
    if (cleanupRunId !== undefined && database && supervisor) {
      try {
        let owner = getRunProcessOwner(database, cleanupRunId);
        if (!owner) throw new Error("HERMES_ACCEPTANCE_OWNER_MISSING");
        if (owner.state !== "STOPPED" || !isCanonicalRunProcessStopEvidence(owner.stopEvidence)) {
          if (owner.state === "PREPARED") {
            database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
              runId: cleanupRunId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
            }));
            owner = getRunProcessOwner(database, cleanupRunId);
          } else {
            // Prefer the real adapter path: it stops its active scope and persists STOPPED itself.
            await runService?.cancelRun(cleanupRunId).catch(() => undefined);
            owner = getRunProcessOwner(database, cleanupRunId);
          }
          if (!owner) throw new Error("HERMES_ACCEPTANCE_OWNER_MISSING");
          if (owner.state !== "STOPPED" || !isCanonicalRunProcessStopEvidence(owner.stopEvidence)) {
            const identity = toScopeIdentity(owner);
            let observed: ProcessScopeObservation = await supervisor.inspect(identity);
            if (observed.state === "LIVE") {
              observed = await supervisor.stop(observed.identity);
              if (observed.state === "LIVE") observed = await supervisor.waitForStopped(observed.identity, POLL_LIMIT_MS);
            }
            if (observed.state !== "STOPPED") throw new Error("HERMES_ACCEPTANCE_CLEANUP_STOP_UNPROVEN");
            const current = getRunProcessOwner(database, cleanupRunId);
            if (!current) throw new Error("HERMES_ACCEPTANCE_OWNER_MISSING");
            database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
              runId: cleanupRunId, expectedState: current.state, nextState: "STOPPED", evidence: observed.evidence,
            }));
          }
        }
        if (runService) {
          await runService.cancelRun(cleanupRunId).catch(() => undefined);
        }
        const stopped = getRunProcessOwner(database, cleanupRunId);
        if (!stopped || stopped.state !== "STOPPED" || !isCanonicalRunProcessStopEvidence(stopped.stopEvidence)) {
          throw new Error("HERMES_ACCEPTANCE_CLEANUP_STOP_EVIDENCE_MISSING");
        }
        if (execution && !executionSettled) await Promise.race([execution, delay(2_000)]);
      } catch (error) {
        cleanupFailure = error instanceof Error && error.message.startsWith("HERMES_ACCEPTANCE_")
          ? error
          : new Error("HERMES_ACCEPTANCE_CLEANUP_STOP_UNPROVEN");
      }
    }

    database?.close();
    database = undefined;
    restoreHomeEnvironment(priorHome, homeWasSet);
    if (root && cleanupFailure === undefined) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
  });

  it("lists exactly one live Run session by its persisted source tag without binding or resuming it", async () => {
    expect(["win32", "linux"]).toContain(process.platform);
    const versionResult = await executor.exec("hermes", ["--version"], {
      env: commandEnvironment(), cwd: repositoryRoot, timeout: QUERY_TIMEOUT_MS, maxBuffer: 8_192,
    }).catch(() => { throw new Error("HERMES_ACCEPTANCE_CLI_VERSION_QUERY_FAILED"); });
    const versionLine = versionResult.stdout.trim().split(/\r?\n/u)[0]?.trim() ?? "";
    expect(versionResult.exitCode).toBe(0);
    expect(versionLine).toBe(EXPECTED_HERMES_VERSION);

    root = await mkdtemp(join(tmpdir(), "ebb-hermes-session-tag-"));
    const databasePath = join(root, "state.sqlite");
    const hermesHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "", "utf8");
    await mkdir(join(workspace, ".ebb-orchestrator"), { recursive: true });
    await writeFile(join(workspace, ".ebb-orchestrator", "project.yaml"), "schema_version: 1\nproject:\n  name: task5b-acceptance\n  default_branch: master\n", "utf8");
    execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Ebb Acceptance", "-c", "user.email=acceptance@example.invalid", "add", "."], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Ebb Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "--quiet", "-m", "Task 5B isolated acceptance workspace"], { cwd: workspace, windowsHide: true });

    priorHome = process.env.EBB_ORCHESTRATOR_HOME;
    homeWasSet = Object.hasOwn(process.env, "EBB_ORCHESTRATOR_HOME");
    process.env.EBB_ORCHESTRATOR_HOME = hermesHome;

    database = createSqliteDatabase(databasePath);
    runMigrations(database, loadTestMigrations());
    const taskId = await seedTaskAndApprovedConfig(database, workspace);
    supervisor = createPlatformSupervisor(executor);
    runService = new RunService(database, new HermesRuntimeAdapter(executor, undefined, {
      databasePath,
      resultDirectory: join(hermesHome, "runtime", "hermes", "results"),
      checkpointDirectory: join(hermesHome, "runtime", "checkpoints"),
      managedWorktree: workspace,
      timeoutMs: 120_000,
      environment: runtimeEnvironment(),
      homeEnvironment: runtimeHomeEnvironment(hermesHome),
    }, supervisor));

    const baseOptions = {
      role: "developer", model: process.env.HERMES_MODEL?.trim() || "default", taskId, epicId: null,
      triggerReason: "hermes-session-tag-acceptance", contextVersion: "plan20-task5b-v1", outputSchemaVersion: "1",
      capability: { workspace }, prompt: "For this acceptance probe, make no workspace changes. Inspect only enough context to understand that this is a temporary verification run, then remain active while the Orchestrator observes your source-tagged Hermes session. Submit one harmless structured result if the runtime requires it.",
    } satisfies Omit<StartRunOptions, "contextInput">;
    const targetHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    const contextInput = createRunContextInput(baseOptions, {
      prompt: baseOptions.prompt,
      roleInputs: {},
      workspaceIdentity: { repository: workspace, workspace, worktree: "task5b-acceptance" },
      targetHead,
      targetBranch: "master",
    });
    const run = runService.prepareRun({ ...baseOptions, contextInput });
    runId = run.id;
    execution = runService.executePreparedRun(run.id).then(
      () => { executionSettled = true; },
      () => { executionSettled = true; },
    );

    const liveOwner = await waitForLiveOwner(database, supervisor, run.id, 30_000);
    expect(liveOwner.sourceTag).toBe(`ebb-run:${run.id}`);
    expect(liveOwner.state).toBe("LIVE");
    expect(liveOwner.hermesHome).toContain(hermesHome);

    const deadline = Date.now() + POLL_LIMIT_MS;
    let matched: { owner: ReturnType<typeof getRunProcessOwner>; stdout: string; sessionId: string } | undefined;
    let lastSafeFailure = "HERMES_SESSION_ID_UNAVAILABLE";
    while (Date.now() < deadline && !matched) {
      const before = getRunProcessOwner(database, run.id);
      if (!before || before.state !== "LIVE" || before.sourceTag !== liveOwner.sourceTag) {
        throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
      }
      await assertOsOwnerLive(supervisor, before);
      const lookup = await executor.exec("hermes", ["sessions", "list", "--source", before.sourceTag, "--limit", "200"], {
        env: commandEnvironment(before.hermesHome), cwd: workspace, timeout: QUERY_TIMEOUT_MS, maxBuffer: 64 * 1024,
      }).catch(() => null);
      if (!lookup || lookup.exitCode !== 0) {
        lastSafeFailure = "HERMES_SESSION_LIST_QUERY_FAILED";
      } else {
        const after = getRunProcessOwner(database, run.id);
        if (!after || after.state !== "LIVE" || after.sourceTag !== before.sourceTag || after.containmentId !== before.containmentId) {
          throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
        }
        await assertOsOwnerLive(supervisor, after);
        await persistEvidence({ versionLine, runId: run.id, sourceTag: after.sourceTag, output: lookup.stdout });
        const ids = parseSessionIds(lookup.stdout);
        if (ids.length > 1) throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
        if (ids.length === 1) matched = { owner: after, stdout: lookup.stdout, sessionId: ids[0]! };
      }
      if (!matched && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
    }
    if (!matched) throw new Error(lastSafeFailure);
    const match = matched;
    const matchedOwner = match.owner;
    if (!matchedOwner) throw new Error("HERMES_SESSION_ID_UNAVAILABLE");

    const sessionRow = database.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: run.id });
    expect(sessionRow?.session_id).toBeNull();
    expect(run.sessionId).toBeNull();
    await persistEvidence({ versionLine, runId: run.id, sourceTag: matchedOwner.sourceTag, output: match.stdout });
    expect(matchedOwner.state).toBe("LIVE");
    expect(match.sessionId).toMatch(/^\d{8}_\d{6}_[a-f0-9]{6}$/u);

    await runService.cancelRun(run.id);
    await execution;
    const stopped = getRunProcessOwner(database, run.id);
    expect(stopped?.state).toBe("STOPPED");
    expect(isCanonicalRunProcessStopEvidence(stopped?.stopEvidence)).toBe(true);
    expect(database.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: run.id })?.session_id).toBeNull();
  }, 180_000);
});

async function seedTaskAndApprovedConfig(database: Database, workspace: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const taskId = randomUUID();
  database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'task5b-acceptance','Task5B Acceptance','ACTIVE',$now,$now)", { id: projectId, now });
  const approvalService = new ApprovalService(database);
  const onboardingApproval = approvalService.request({ type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "acceptance" });
  approvalService.approve(onboardingApproval.id, "acceptance");
  const projectYaml = "schema_version: 1\nproject:\n  name: task5b-acceptance\n  default_branch: master\n";
  const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
  const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
  const hashDomain = (domain: string, value: string) => createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex");
  const sortValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, entry]) => [key, sortValue(entry)]))
    : value;
  const payload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
  const candidate = new ProjectConfigRepository(database).capture({
    projectId, sourceHead: "a".repeat(40), manifestJson,
    manifestHash: hashDomain("ebb-project-config-manifest-v1\0", manifestJson),
    sourceFilesJson: JSON.stringify(sourceFiles), normalizedPayloadJson: JSON.stringify(sortValue(payload)), schemaVersion: 1,
  });
  new ProjectConfigService(database, approvalService).approve(projectId, candidate.candidate_id, candidate.manifest_hash);
  database.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'TASK-5B','Live Hermes source-tag proof','READY',$contract,$now,$now)", {
    id: taskId, projectId,
    contract: JSON.stringify({ version: 1, goal: "Prove Hermes live session source-tag visibility", context: "Temporary isolated acceptance task; do not modify workspace files.", requirements: ["Run Hermes with the durable source tag"], acceptanceCriteria: ["One live session ID is listable by source"], dependencies: [], nonGoals: ["No code changes", "No session handoff"], definitionOfDone: ["Persisted session_id remains null"] }),
    now,
  });
  database.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$workspace,$workspace,'master',$now)", { id: taskId, workspace, now });
  return taskId;
}

function createPlatformSupervisor(executor: ProcessExecutor): ProcessScopeSupervisor {
  if (process.platform === "win32") return new WindowsJobSupervisor(executor);
  if (process.platform === "linux") return new SystemdRunSupervisor(executor);
  throw new Error("HERMES_ACCEPTANCE_PLATFORM_UNSUPPORTED");
}

function toScopeIdentity(owner: NonNullable<ReturnType<typeof getRunProcessOwner>>): ProcessScopeIdentity {
  return {
    runId: owner.runId, containmentKind: owner.containmentKind, containmentId: owner.containmentId,
    launchNonce: owner.launchNonce, systemdInvocationId: owner.systemdInvocationId,
    systemdControlGroup: owner.systemdControlGroup, supervisorPid: owner.supervisorPid,
    supervisorStartIdentity: owner.supervisorStartIdentity, pid: owner.pid, platform: owner.platform,
    processStartIdentity: owner.processStartIdentity, executableIdentity: owner.executableIdentity,
    state: owner.state,
  };
}

async function waitForLiveOwner(database: Database, supervisor: ProcessScopeSupervisor, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owner = getRunProcessOwner(database, id);
    if (owner?.state === "LIVE") {
      await assertOsOwnerLive(supervisor, owner);
      return owner;
    }
    if (owner && ["STOPPED", "UNKNOWN"].includes(owner.state)) throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
}

async function assertOsOwnerLive(supervisor: ProcessScopeSupervisor, owner: NonNullable<ReturnType<typeof getRunProcessOwner>>): Promise<void> {
  const observation = await supervisor.inspect(toScopeIdentity(owner));
  if (observation.state !== "LIVE" || observation.identity.runId !== owner.runId ||
      observation.identity.containmentId !== owner.containmentId || observation.identity.launchNonce !== owner.launchNonce) {
    throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
  }
}

/** Читает только завершающее поле session ID из строк Hermes table для зафиксированной версии. */
function parseSessionIds(output: string): string[] {
  const lines = output.replace(/\r\n/gu, "\n").split("\n");
  if (lines.length === 1 && lines[0]?.trim() === "No sessions found.") return [];
  const headerIndex = lines.findIndex((line) => /\bID\s*$/u.test(line) && /\b(?:Preview|Title)\b/u.test(line));
  if (headerIndex < 0 || !/^─{40,}$/u.test(lines[headerIndex + 1]?.trim() ?? "")) {
    throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
  }
  const ids: string[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim() || /^Showing\b/u.test(line)) continue;
    const match = line.match(/(?:^|\s)(\d{8}_\d{6}_[a-f0-9]{6})\s*$/u);
    if (!match) throw new Error("HERMES_SESSION_ID_UNAVAILABLE");
    ids.push(match[1]!);
  }
  return ids;
}

async function persistEvidence(input: { versionLine: string; runId: string; sourceTag: string; output: string }): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  const contents = [
    `Hermes version: ${input.versionLine}`,
    `Run ID: ${input.runId}`,
    `Source tag: ${input.sourceTag}`,
    "--- exact hermes sessions list stdout ---",
    input.output,
    "--- end stdout ---",
  ].join("\n");
  await writeFile(evidencePath, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
}

function commandEnvironment(hermesHome?: string): Record<string, string> {
  const allowed = ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "NODE_ENV"];
  const environment = Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  if (hermesHome) {
    environment.HERMES_HOME = hermesHome;
    environment.HOME = join(hermesHome, "home");
  }
  return environment;
}

function runtimeEnvironment(): Record<string, string> {
  const environment = commandEnvironment();
  return Object.fromEntries(Object.entries(environment).filter(([key]) => ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "NODE_ENV"].includes(key)));
}

function runtimeHomeEnvironment(home: string) {
  return process.platform === "win32" ? { EBB_ORCHESTRATOR_HOME: home, USERPROFILE: home } : { EBB_ORCHESTRATOR_HOME: home, HOME: home };
}

function restoreHomeEnvironment(previous: string | undefined, hadOwn: boolean): void {
  if (hadOwn && previous !== undefined) process.env.EBB_ORCHESTRATOR_HOME = previous;
  else delete process.env.EBB_ORCHESTRATOR_HOME;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
