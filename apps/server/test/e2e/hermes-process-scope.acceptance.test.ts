import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRunProcessOwner, insertRunProcessOwnerTx, preflightRunProcessOwners, prepareRunProcessOwner, transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import type { Database } from "../../src/platform/database/database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { inspectCgroupTree, type ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import { ProcessExecutor, type ProcessResult } from "../../src/platform/process/process-executor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import type { ProcessScopeHandle } from "../../src/platform/process/run-scope-supervisor.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTestMigrations } from "../helpers/migrations.js";

const CANARY = "EbbProcessScopeCanary_5A_dummy_only_d8a5c3";
const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";
const nativeAcceptanceEnabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const restartChildScript = join(repositoryRoot, "apps/server/test/helpers/hermes-process-scope-restart-child.ts");
const tsxLoader = join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");

describe("managerEnvironment", () => {
  it("normalizes a trailing slash before validating the WSL session bus address", () => {
    const keys = ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.PATH = "/usr/bin";
    process.env.XDG_RUNTIME_DIR = "/run/user/1002/";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1002/bus";

    try {
      expect(managerEnvironment()).toMatchObject({
        XDG_RUNTIME_DIR: "/run/user/1002",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1002/bus",
      });
    } finally {
      for (const key of keys) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe.skipIf(!isLinux || !nativeAcceptanceEnabled)("Linux native process-scope acceptance", () => {
  let directory = "";
  let database: Database | undefined;
  let handle: ProcessScopeHandle | undefined;
  let scopeIdentity: ProcessScopeIdentity | undefined;
  const executor = new ProcessExecutor();
  const supervisor = new SystemdRunSupervisor(executor);

  afterEach(async () => {
    let cleanupError: unknown;
    try {
      if (database && scopeIdentity) await stopAndPersistIfNeeded(database, supervisor, scopeIdentity);
    } catch (error) {
      cleanupError = error;
    } finally {
      database?.close();
      database = undefined;
      handle = undefined;
      scopeIdentity = undefined;
    }
    if (directory && cleanupError === undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = "";
    }
    if (cleanupError !== undefined) throw cleanupError;
  });

  it("reopens the persisted owner in a recovery child after the launcher client crashes", async () => {
    await assertLinuxRunnerPrerequisites(executor);
    await runRestartBoundaryAcceptance();
  }, 120_000);

  it("keeps a setsid descendant in the durable systemd cgroup after its root exits and stops the exact scope", async () => {
    await assertLinuxRunnerPrerequisites(executor);
    directory = await mkdtemp(join(tmpdir(), "ebb-process-scope-5a-"));
    database = createSqliteDatabase(join(directory, "state.sqlite"));
    runMigrations(database, loadTestMigrations());

    const runId = randomUUID();
    const runHome = join(directory, "hermes-home");
    const payloadDigestPath = join(directory, "payload-secret-sha256.txt");
    const descendantPidPath = join(directory, "setsid-descendant.pid");
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','dummy-5a','STARTED',$startedAt)",
      { id: runId, startedAt: new Date().toISOString() },
    );
    const owner = prepareRunProcessOwner(runId, runHome, "systemd-user-service");
    database.transaction((tx) => {
      insertRunProcessOwnerTx(tx, owner);
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
    });
    const unitName = `ebb-orchestrator-run-${owner.containmentId}`;
    scopeIdentity = toScopeIdentity(getRunProcessOwner(database, runId));

    const payload = [
      "const { spawn } = require('node:child_process');",
      "const { createHash } = require('node:crypto');",
      "const { writeFileSync } = require('node:fs');",
      "const key = process.env.EBB_HERMES_PROVIDER_API_KEY;",
      "if (!key) process.exit(20);",
      "writeFileSync(process.argv[1], createHash('sha256').update(key).digest('hex'));",
      "const child = spawn('setsid', ['/bin/sh', '-c', 'sleep 60'], { stdio: 'ignore' });",
      "child.once('error', () => process.exit(21));",
      "child.once('spawn', () => { writeFileSync(process.argv[2], String(child.pid)); child.unref(); process.stdout.write('dummy payload root complete\\n'); });",
    ].join(" ");
    handle = await supervisor.launch(scopeIdentity, {
      executable: process.execPath,
      args: ["-e", payload, payloadDigestPath, descendantPidPath],
      cwd: directory,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: homedir(),
        HERMES_HOME: runHome,
        NODE_ENV: "test",
      },
      secret: CANARY,
      timeoutMs: 60_000,
    }, async (identity) => {
      database!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: {
          systemdInvocationId: identity.systemdInvocationId,
          systemdControlGroup: identity.systemdControlGroup,
          pid: identity.pid,
          platform: identity.platform,
        },
      }));
      scopeIdentity = identity;
    });

    const persistedOwner = getRunProcessOwner(database, runId);
    expect(persistedOwner?.state).toBe("LIVE");
    const payloadDigest = await waitForFile(payloadDigestPath);
    const descendantPid = Number(await waitForFile(descendantPidPath));
    expect(payloadDigest).toBe(createHash("sha256").update(CANARY).digest("hex"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);

    const reopenedSupervisor = new SystemdRunSupervisor(new ProcessExecutor());
    const reopenedIdentity = toScopeIdentity(persistedOwner);
    const liveState = await waitFor(async () => {
      const observation = await reopenedSupervisor.inspect(reopenedIdentity);
      if (observation.state !== "LIVE" || !observation.identity.systemdControlGroup) return undefined;
      const properties = await showUnitProperties(executor, unitName, ["MainPID", "ControlGroup", "ActiveState"]);
      const cgroup = await inspectCgroupTree(observation.identity.systemdControlGroup);
      if (properties.get("MainPID") !== "0" || !cgroup.readable || !cgroup.populated || !cgroup.processIds.includes(descendantPid)) {
        return undefined;
      }
      return { observation, properties, cgroup };
    });
    expect(liveState.observation.state).toBe("LIVE");
    expect(liveState.properties.get("ActiveState")).toBe("active");
    expect(liveState.properties.get("ControlGroup")).toBe(persistedOwner?.systemdControlGroup);
    expect(liveState.cgroup.processIds).toContain(descendantPid);

    const requiredProperties = await showUnitProperties(executor, unitName, [
      "Type", "ExitType", "KillMode", "Delegate", "ProtectControlGroups", "Restart", "Environment", "ExecStart",
    ]);
    expect(requiredProperties.get("Type")).toBe("exec");
    expect(requiredProperties.get("ExitType")).toBe("cgroup");
    expect(requiredProperties.get("KillMode")).toBe("control-group");
    expect(requiredProperties.get("Delegate")).toBe("no");
    expect(requiredProperties.get("ProtectControlGroups")).toBe("yes");
    expect(requiredProperties.get("Restart")).toBe("no");
    expect([...requiredProperties.entries()].map(([key, value]) => `${key}=${value}`).join("\n")).not.toContain(CANARY);

    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "LIVE", nextState: "STOPPING",
    }));
    const stoppingOwner = toScopeIdentity(getRunProcessOwner(database, runId));
    const stopped = await reopenedSupervisor.stop(stoppingOwner);
    expect(stopped.state).toBe("STOPPED");
    if (stopped.state !== "STOPPED") throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "STOPPING", nextState: "STOPPED", evidence: stopped.evidence,
    }));
    const completion = await handle.completion;
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain(CANARY);

    const journal = await executor.exec("journalctl", ["--user", "--unit", `${unitName}.service`, "--no-pager", "--output=cat"], {
      env: managerEnvironment(), timeout: 10_000,
    });
    expect(`${journal.stdout}\n${journal.stderr}`).not.toContain(CANARY);
    expect(JSON.stringify({
      runs: database.all("SELECT * FROM agent_runs"),
      owners: database.all("SELECT * FROM run_process_owners"),
    })).not.toContain(CANARY);
    expect(getRunProcessOwner(database, runId)?.state).toBe("STOPPED");
  }, 90_000);
});

describe.skipIf(!isWindows || !nativeAcceptanceEnabled)("Windows native process-scope acceptance", () => {
  let directory = "";
  let database: Database | undefined;
  let handle: ProcessScopeHandle | undefined;
  let identity: ProcessScopeIdentity | undefined;
  const executor = new ProcessExecutor();
  const supervisor = new WindowsJobSupervisor(executor);

  afterEach(async () => {
    let cleanupError: unknown;
    try {
      if (database && identity) await stopWindowsScopeIfNeeded(database, supervisor, identity);
    } catch (error) {
      cleanupError = error;
    } finally {
      database?.close();
      database = undefined;
      handle = undefined;
      identity = undefined;
    }
    if (directory && cleanupError === undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = "";
    }
    if (cleanupError !== undefined) throw cleanupError;
  });

  it("reopens the persisted UNKNOWN owner after launcher crash and native helper cleanup", async () => {
    const helperPath = fileURLToPath(new URL("../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
    await access(helperPath, constants.X_OK).catch(() => access(helperPath));
    await runRestartBoundaryAcceptance();
  }, 120_000);

  it("proves exact helper-process crash closes its Job and a new preflight records authoritative STOPPED evidence", async () => {
    const helperPath = fileURLToPath(new URL("../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
    await access(helperPath, constants.X_OK).catch(() => access(helperPath));
    await runWindowsHelperCrashBoundaryAcceptance();
  }, 120_000);

  it("keeps an absent Job UNKNOWN when LAUNCHING lacks helper identity and preserves PREPARED never-launched proof", async () => {
    const helperPath = fileURLToPath(new URL("../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
    await access(helperPath, constants.X_OK).catch(() => access(helperPath));
    const preparedOwner = prepareRunProcessOwner(randomUUID(), join(tmpdir(), "ebb-process-scope-win-never-launched"), "windows-job");
    const preparedIdentity = toScopeIdentity(preparedOwner);
    const inspector = new WindowsJobSupervisor(new ProcessExecutor());

    await expect(inspector.inspect({ ...preparedIdentity, state: "LAUNCHING" })).resolves.toEqual({
      state: "UNKNOWN", reason: "WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING",
    });
    await expect(inspector.inspect(preparedIdentity)).resolves.toEqual({
      state: "STOPPED", evidence: "NEVER_LAUNCHED",
    });
  });

  it("recovers a durable UNKNOWN owner only after native proof that its exact helper and Job are absent", async () => {
    const helperPath = fileURLToPath(new URL("../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
    await access(helperPath, constants.X_OK).catch(() => access(helperPath));
    directory = await mkdtemp(join(tmpdir(), "ebb-process-scope-win-recovery-"));
    database = createSqliteDatabase(join(directory, "state.sqlite"));
    runMigrations(database, loadTestMigrations());

    const runId = randomUUID();
    const runHome = join(directory, "hermes-home");
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','dummy-5a','STARTED',$startedAt)",
      { id: runId, startedAt: new Date().toISOString() },
    );
    const prepared = prepareRunProcessOwner(runId, runHome, "windows-job");
    database.transaction((tx) => {
      insertRunProcessOwnerTx(tx, prepared);
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
    });
    identity = toScopeIdentity(getRunProcessOwner(database, runId));

    handle = await supervisor.launch(identity, {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
      environment: windowsChildEnvironment(runHome),
      secret: CANARY,
      timeoutMs: 60_000,
    }, async (verifiedIdentity) => {
      database!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: {
          supervisorPid: verifiedIdentity.supervisorPid,
          supervisorStartIdentity: verifiedIdentity.supervisorStartIdentity,
          pid: verifiedIdentity.pid,
          platform: verifiedIdentity.platform,
          processStartIdentity: verifiedIdentity.processStartIdentity,
          executableIdentity: verifiedIdentity.executableIdentity,
        },
      }));
      identity = verifiedIdentity;
    });
    const completion = await handle.completion;
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain(CANARY);
    const liveOwner = getRunProcessOwner(database, runId);
    expect(liveOwner?.state).toBe("LIVE");
    if (!liveOwner?.supervisorPid || !liveOwner.supervisorStartIdentity) throw new Error("WINDOWS_HELPER_IDENTITY_NOT_PERSISTED");

    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "LIVE", nextState: "UNKNOWN", evidence: "OS_STATE_UNPROVEN",
    }));
    identity = toScopeIdentity(getRunProcessOwner(database, runId));
    expect(await processExists(liveOwner.supervisorPid)).toBe(false);

    let preflightError: unknown;
    try {
      await preflightRunProcessOwners(database, new WindowsJobSupervisor(new ProcessExecutor()));
    } catch (error) {
      preflightError = error;
    }
    const recoveredOwner = getRunProcessOwner(database, runId);
    if (preflightError !== undefined && recoveredOwner?.state === "UNKNOWN") {
      // Keep the RED run leak-free: STOPPING still requires the same exact persisted helper identity.
      const cleanupIdentity = { ...toScopeIdentity(recoveredOwner), state: "STOPPING" as const };
      const cleanupProof = await new WindowsJobSupervisor(new ProcessExecutor()).inspect(cleanupIdentity);
      if (cleanupProof.state === "STOPPED") {
        database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId, expectedState: "UNKNOWN", nextState: "STOPPED", evidence: cleanupProof.evidence,
        }));
      }
    }

    expect(preflightError).toBeUndefined();
    expect(getRunProcessOwner(database, runId)?.state).toBe("STOPPED");
  }, 90_000);

  it("keeps a descendant in the named non-breakaway Job until exact-scope stop and transports the canary only through stdin", async () => {
    const helperPath = fileURLToPath(new URL("../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
    await access(helperPath, constants.X_OK).catch(() => access(helperPath));
    directory = await mkdtemp(join(tmpdir(), "ebb-process-scope-win-5a-"));
    database = createSqliteDatabase(join(directory, "state.sqlite"));
    runMigrations(database, loadTestMigrations());

    const runId = randomUUID();
    const runHome = join(directory, "hermes-home");
    const secretDigestPath = join(directory, "payload-secret-sha256.txt");
    const descendantPidPath = join(directory, "descendant.pid");
    const heartbeatPath = join(directory, "descendant-heartbeat.txt");
    const descendantExitPath = join(directory, "descendant-exit.txt");
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','dummy-5a','STARTED',$startedAt)",
      { id: runId, startedAt: new Date().toISOString() },
    );
    const prepared = prepareRunProcessOwner(runId, runHome, "windows-job");
    database.transaction((tx) => {
      insertRunProcessOwnerTx(tx, prepared);
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
    });
    identity = toScopeIdentity(getRunProcessOwner(database, runId));

    const childPayload = [
      "const fs=require('node:fs');",
      "process.on('uncaughtException', error => { try { fs.writeFileSync(process.argv[2], String(error.stack || error)); } finally { process.exit(22); } });",
      "let count=0;",
      "fs.writeFileSync(process.argv[1],'started');",
      "setInterval(()=>fs.writeFileSync(process.argv[1],String(++count)),20);",
    ].join("");
    const parentPayload = [
      "const {spawn}=require('node:child_process');",
      "const {createHash}=require('node:crypto');",
      "const fs=require('node:fs');",
      "const key=process.env.EBB_HERMES_PROVIDER_API_KEY;",
      "if(!key)process.exit(20);",
      `fs.writeFileSync(${JSON.stringify(secretDigestPath)},createHash('sha256').update(key).digest('hex'));`,
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childPayload)},${JSON.stringify(heartbeatPath)},${JSON.stringify(descendantExitPath)}],{stdio:'ignore',windowsHide:true,detached:true});`,
      "child.once('error',()=>process.exit(21));",
      `child.once('exit',code=>fs.writeFileSync(${JSON.stringify(descendantExitPath)},String(code)));`,
      `child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));child.unref();process.stdout.write('dummy payload root complete\\n');});`,
    ].join("");
    handle = await supervisor.launch(identity, {
      executable: process.execPath,
      args: ["-e", parentPayload],
      cwd: directory,
      environment: windowsChildEnvironment(runHome),
      secret: CANARY,
      timeoutMs: 60_000,
    }, async (verifiedIdentity) => {
      database!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: {
          supervisorPid: verifiedIdentity.supervisorPid,
          supervisorStartIdentity: verifiedIdentity.supervisorStartIdentity,
          pid: verifiedIdentity.pid,
          platform: verifiedIdentity.platform,
          processStartIdentity: verifiedIdentity.processStartIdentity,
          executableIdentity: verifiedIdentity.executableIdentity,
        },
      }));
      identity = verifiedIdentity;
    });

    const persistedOwner = getRunProcessOwner(database, runId);
    expect(persistedOwner?.state).toBe("LIVE");
    expect(await waitForFile(secretDigestPath)).toBe(createHash("sha256").update(CANARY).digest("hex"));
    const descendantPid = Number(await waitForFile(descendantPidPath));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    const firstHeartbeat = await waitFor(async () => {
      try { return await readFile(heartbeatPath, "utf8"); } catch { /* wait for first heartbeat */ }
      try {
        const failure = await readFile(descendantExitPath, "utf8");
        throw new Error(`WINDOWS_DESCENDANT_EXITED_BEFORE_HEARTBEAT:${failure}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("WINDOWS_DESCENDANT_EXITED_BEFORE_HEARTBEAT:")) throw error;
      }
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(heartbeatPath, "utf8")).not.toBe(firstHeartbeat);

    const reopened = new WindowsJobSupervisor(new ProcessExecutor());
    const live = await reopened.inspect(toScopeIdentity(persistedOwner));
    expect(live.state).toBe("LIVE");
    if (live.state !== "LIVE") throw new Error("WINDOWS_JOB_MEMBERSHIP_UNPROVEN");
    expect(live.identity.containmentId).toBe(persistedOwner?.containmentId);
    expect(live.identity.launchNonce).toBe(persistedOwner?.launchNonce);

    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "LIVE", nextState: "STOPPING",
    }));
    const stopping = toScopeIdentity(getRunProcessOwner(database, runId));
    const stopped = await reopened.stop(stopping);
    expect(stopped.state).toBe("STOPPED");
    if (stopped.state !== "STOPPED") throw new Error("WINDOWS_JOB_STOP_UNPROVEN");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "STOPPING", nextState: "STOPPED", evidence: stopped.evidence,
    }));
    const completion = await handle.completion;
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain(CANARY);
    const finalHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await readFile(heartbeatPath, "utf8")).toBe(finalHeartbeat);
    expect(JSON.stringify({
      runs: database.all("SELECT * FROM agent_runs"),
      owners: database.all("SELECT * FROM run_process_owners"),
    })).not.toContain(CANARY);
    expect(getRunProcessOwner(database, runId)?.state).toBe("STOPPED");
    const finalInspection = await reopened.inspect(stopping);
    expect(finalInspection.state).toBe("STOPPED");
    if (finalInspection.state !== "STOPPED") throw new Error("WINDOWS_JOB_STOP_UNPROVEN");
    expect(["WINDOWS_JOB_EMPTY", "WINDOWS_JOB_AND_HELPER_ABSENT"]).toContain(finalInspection.evidence);
    expect(await processExists(descendantPid)).toBe(false);
  }, 90_000);
});

interface RestartWorker {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: { stdout: string; stderr: string };
}

interface RestartMarker {
  processId: number;
  processGroupId: number | null;
  runId: string;
  containmentId: string;
  state: string;
  supervisorPid: number | null;
  supervisorStartIdentity: string | null;
  payloadPid: number | null;
  platform: string | null;
  systemdInvocationId: string | null;
  systemdControlGroup: string | null;
}

async function runRestartBoundaryAcceptance(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `ebb-process-scope-restart-${process.platform}-`));
  const databasePath = join(directory, "state.sqlite");
  const runId = randomUUID();
  const runHome = join(directory, "hermes-home");
  const digestPath = join(directory, "payload-secret-sha256.txt");
  const descendantPidPath = join(directory, "descendant.pid");
  const heartbeatPath = join(directory, "descendant-heartbeat.txt");
  const descendantExitPath = join(directory, "descendant-exit.txt");
  const readyPath = join(directory, "launcher-ready.json");
  const recoveryPath = join(directory, "recovery-result.json");
  const executor = new ProcessExecutor();
  let launcher: RestartWorker | undefined;
  let ready: RestartMarker | undefined;
  let recoverySucceeded = false;
  let testError: unknown;
  let cleanupError: unknown;

  try {
    const launchArgs = [
      "launch", databasePath, runId, runHome, heartbeatPath, digestPath,
      descendantPidPath, descendantExitPath, readyPath,
    ];
    const launcherEnvironment = restartWorkerEnvironment(runHome);
    expect(JSON.stringify(launchArgs)).not.toContain(CANARY);
    expect(JSON.stringify(launcherEnvironment)).not.toContain(CANARY);
    launcher = spawnRestartWorker(launchArgs, CANARY, launcherEnvironment, isLinux);

    ready = JSON.parse(await waitForRestartMarker(readyPath, launcher, 60_000)) as RestartMarker;
    expect(ready.runId).toBe(runId);
    expect(ready.processId).toBe(launcher.child.pid);
    expect(ready.state).toBe(isWindows ? "UNKNOWN" : "LIVE");
    expect(await waitForFile(digestPath)).toBe(createHash("sha256").update(CANARY).digest("hex"));
    const descendantPid = Number(await waitForFile(descendantPidPath));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    expect(JSON.stringify(launcher.output)).not.toContain(CANARY);

    let unitName: string | undefined;
    if (isWindows) {
      if (!ready.supervisorPid || !ready.supervisorStartIdentity) throw new Error("WINDOWS_HELPER_IDENTITY_NOT_PERSISTED");
      const firstHeartbeat = await waitForFile(heartbeatPath);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(await readFile(heartbeatPath, "utf8")).not.toBe(firstHeartbeat);
    } else {
      if (!ready.systemdControlGroup || !ready.systemdInvocationId || ready.processGroupId !== ready.processId) {
        throw new Error("LINUX_RESTART_IDENTITY_NOT_PERSISTED");
      }
      expect(await readLinuxProcessGroup(ready.processId)).toBe(ready.processGroupId);
      unitName = `ebb-orchestrator-run-${ready.containmentId}.service`;
      const activeService = await waitFor(async () => {
        const properties = await showUnitProperties(executor, unitName!, ["MainPID", "ControlGroup", "ActiveState"]);
        const cgroup = await inspectCgroupTree(ready!.systemdControlGroup!);
        if (properties.get("MainPID") !== "0" || properties.get("ActiveState") !== "active" ||
            properties.get("ControlGroup") !== ready!.systemdControlGroup || !cgroup.readable ||
            !cgroup.populated || !cgroup.processIds.includes(descendantPid)) return undefined;
        return { properties, cgroup };
      });
      expect(activeService.properties.get("ActiveState")).toBe("active");
      expect(activeService.cgroup.processIds).toContain(descendantPid);
    }

    expect(launcher.child.exitCode).toBeNull();
    expect(launcher.child.signalCode).toBeNull();
    const launcherPid = launcher.child.pid;
    await terminateRestartLauncher(launcher, ready.processGroupId, 15_000);
    expect(launcher.child.exitCode !== null || launcher.child.signalCode !== null).toBe(true);
    expect(launcherPid).toBe(ready.processId);
    expect(JSON.stringify(launcher.output)).not.toContain(CANARY);
    launcher = undefined;

    if (isWindows) {
      await waitFor(async () => (await processExists(ready!.supervisorPid!)) ? undefined : true, 15_000);
      await waitFor(async () => (await processExists(descendantPid)) ? undefined : true, 15_000);
      const finalHeartbeat = await readFile(heartbeatPath, "utf8");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      expect(await readFile(heartbeatPath, "utf8")).toBe(finalHeartbeat);
    } else {
      expect(await processExists(descendantPid)).toBe(true);
      const serviceAfterLauncherCrash = await waitFor(async () => {
        const properties = await showUnitProperties(executor, unitName!, ["MainPID", "ControlGroup", "ActiveState"]);
        const cgroup = await inspectCgroupTree(ready!.systemdControlGroup!);
        if (properties.get("MainPID") !== "0" || properties.get("ActiveState") !== "active" ||
            properties.get("ControlGroup") !== ready!.systemdControlGroup || !cgroup.readable ||
            !cgroup.populated || !cgroup.processIds.includes(descendantPid)) return undefined;
        return { properties, cgroup };
      });
      expect(serviceAfterLauncherCrash.properties.get("ActiveState")).toBe("active");
      expect(serviceAfterLauncherCrash.cgroup.processIds).toContain(descendantPid);
      expect(await readLinuxProcessGroup(ready.processId).catch(() => null)).toBeNull();
    }

    const recovery = await runRecoveryWorker(databasePath, runId, recoveryPath, restartWorkerEnvironment(runHome));
    recoverySucceeded = recovery.exit.code === 0 && recovery.result.ok === true;
    expect(recovery.exit.code).toBe(0);
    expect(recovery.result.ok).toBe(true);
    expect(recovery.result.processId).not.toBe(ready.processId);
    expect(recovery.result.previousState).toBe(isWindows ? "UNKNOWN" : "LIVE");
    expect(recovery.result.state).toBe("STOPPED");
    expect(JSON.stringify(recovery.output)).not.toContain(CANARY);

    if (isWindows) {
      await waitFor(async () => (await processExists(descendantPid)) ? undefined : true, 15_000);
      await waitFor(async () => (await processExists(ready!.supervisorPid!)) ? undefined : true, 15_000);
    } else {
      await waitFor(async () => (await processExists(descendantPid)) ? undefined : true, 15_000);
      const stoppedCgroup = await inspectCgroupTree(ready.systemdControlGroup!);
      expect(stoppedCgroup.populated).toBe(false);
      expect(stoppedCgroup.processIds).not.toContain(descendantPid);
      expect(["SYSTEMD_CGROUP_EMPTY", "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT"]).toContain(recovery.result.stopEvidence);
      const journal = await executor.exec("journalctl", ["--user", "--unit", unitName!, "--no-pager", "--output=cat"], {
        env: managerEnvironment(), timeout: 10_000,
      });
      expect(`${journal.stdout}\n${journal.stderr}`).not.toContain(CANARY);
      const clientPids = await linuxProcessesMatching(unitName!);
      expect(clientPids).toEqual([]);
    }

    const finalDatabase = createSqliteDatabase(databasePath);
    try {
      const finalOwner = getRunProcessOwner(finalDatabase, runId);
      expect(finalOwner?.state).toBe("STOPPED");
      expect(JSON.stringify({ owners: finalDatabase.all("SELECT * FROM run_process_owners"), runs: finalDatabase.all("SELECT * FROM agent_runs") })).not.toContain(CANARY);
    } finally {
      finalDatabase.close();
    }
  } catch (error) {
    testError = error;
  } finally {
    try {
      if (launcher) await terminateRestartLauncher(launcher, ready?.processGroupId ?? launcher.child.pid, 15_000);
      if (!recoverySucceeded) {
        const cleanupPath = join(directory, "cleanup-result.json");
        const cleanup = await runRecoveryWorker(databasePath, runId, cleanupPath, restartWorkerEnvironment(runHome));
        recoverySucceeded = cleanup.exit.code === 0 && cleanup.result.ok === true;
      }
      if (!recoverySucceeded) {
        cleanupError = new Error("PROCESS_SCOPE_RESTART_CLEANUP_UNPROVEN");
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  if (testError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([testError, cleanupError], "PROCESS_SCOPE_RESTART_TEST_AND_CLEANUP_FAILED");
  }
  if (testError !== undefined) throw testError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function runWindowsHelperCrashBoundaryAcceptance(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ebb-process-scope-helper-crash-win-"));
  const databasePath = join(directory, "state.sqlite");
  const runId = randomUUID();
  const runHome = join(directory, "hermes-home");
  const digestPath = join(directory, "payload-secret-sha256.txt");
  const descendantPidPath = join(directory, "descendant.pid");
  const heartbeatPath = join(directory, "descendant-heartbeat.txt");
  const descendantExitPath = join(directory, "descendant-exit.txt");
  const readyPath = join(directory, "launcher-ready.json");
  const recoveryPath = join(directory, "recovery-result.json");
  let launcher: RestartWorker | undefined;
  let ready: RestartMarker | undefined;
  let descendantPid: number | undefined;
  let descendantCreationTime: string | undefined;
  let recoverySucceeded = false;
  let testError: unknown;
  let cleanupError: unknown;

  try {
    const launchArgs = [
      "launch", databasePath, runId, runHome, heartbeatPath, digestPath,
      descendantPidPath, descendantExitPath, readyPath,
    ];
    launcher = spawnRestartWorker(launchArgs, CANARY, restartWorkerEnvironment(runHome), false);
    ready = JSON.parse(await waitForRestartMarker(readyPath, launcher, 60_000)) as RestartMarker;
    expect(ready.runId).toBe(runId);
    expect(ready.processId).toBe(launcher.child.pid);
    expect(ready.platform).toBe("win32");
    expect(ready.state).toBe("UNKNOWN");
    if (!ready.supervisorPid || !ready.supervisorStartIdentity || !ready.containmentId) {
      throw new Error("WINDOWS_PERSISTED_HELPER_IDENTITY_MISSING");
    }

    expect(await waitForFile(digestPath)).toBe(createHash("sha256").update(CANARY).digest("hex"));
    const launchedDescendantPid = Number(await waitForFile(descendantPidPath));
    descendantPid = launchedDescendantPid;
    expect(Number.isSafeInteger(launchedDescendantPid)).toBe(true);
    expect(launchedDescendantPid).toBeGreaterThan(0);
    const descendantIdentity = await runWindowsNativeScopeCommand({ mode: "read-creation", processId: launchedDescendantPid });
    const descendantIdentityMatch = /^PROCESS_CREATION_IDENTITY=([1-9][0-9]*)$/u.exec(descendantIdentity.stdout.trim());
    const activeDescendantCreationTime = descendantIdentityMatch?.[1];
    if (typeof activeDescendantCreationTime !== "string" || !/^[1-9][0-9]*$/u.test(activeDescendantCreationTime)) {
      throw new Error("WINDOWS_DESCENDANT_CREATION_IDENTITY_MISSING");
    }
    descendantCreationTime = activeDescendantCreationTime;
    const firstHeartbeat = await waitForFile(heartbeatPath);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    expect(await readFile(heartbeatPath, "utf8")).not.toBe(firstHeartbeat);

    const inspectDatabase = createSqliteDatabase(databasePath);
    let persistedOwner: ReturnType<typeof getRunProcessOwner>;
    try {
      persistedOwner = getRunProcessOwner(inspectDatabase, runId);
      expect(persistedOwner?.state).toBe("UNKNOWN");
      expect(persistedOwner?.supervisorPid).toBe(ready.supervisorPid);
      expect(persistedOwner?.supervisorStartIdentity).toBe(ready.supervisorStartIdentity);
      expect(persistedOwner?.containmentId).toBe(ready.containmentId);
    } finally {
      inspectDatabase.close();
    }
    if (!persistedOwner) throw new Error("RUN_PROCESS_OWNER_MISSING");

    const live = await new WindowsJobSupervisor(new ProcessExecutor()).inspect(toScopeIdentity(persistedOwner));
    expect(live.state).toBe("LIVE");
    const jobMembership = await runWindowsNativeScopeCommand({
      mode: "is-job-member",
      processId: launchedDescendantPid,
      expectedCreationTime: activeDescendantCreationTime,
      containmentId: ready.containmentId,
    });
    expect(jobMembership.stdout.trim()).toBe("EXACT_PROCESS_JOB_MEMBERSHIP_CONFIRMED");

    let mismatchedIdentityError = "";
    try {
      await runWindowsNativeScopeCommand({
        mode: "terminate-exact",
        processId: persistedOwner.supervisorPid!,
        expectedCreationTime: (BigInt(persistedOwner.supervisorStartIdentity!) + 1n).toString(),
      });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      if (typeof stderr === "string") mismatchedIdentityError = stderr;
    }
    expect(mismatchedIdentityError).toContain("PROCESS_CREATION_IDENTITY_MISMATCH");
    expect(await processExists(persistedOwner.supervisorPid!)).toBe(true);

    const killResult = await runWindowsNativeScopeCommand({
      mode: "terminate-exact",
      processId: persistedOwner.supervisorPid!,
      expectedCreationTime: persistedOwner.supervisorStartIdentity!,
    });
    expect(killResult.stdout.trim()).toBe("EXACT_PROCESS_TERMINATED");
    await waitFor(async () => (await processExists(persistedOwner.supervisorPid!)) ? undefined : true, 15_000);
    await waitFor(async () => (await processExists(launchedDescendantPid)) ? undefined : true, 15_000);
    const stoppedHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    expect(await readFile(heartbeatPath, "utf8")).toBe(stoppedHeartbeat);

    const launcherPid = launcher.child.pid;
    await terminateRestartLauncher(launcher, null, 15_000);
    expect(launcherPid).toBe(ready.processId);
    launcher = undefined;

    const recovery = await runRecoveryWorker(databasePath, runId, recoveryPath, restartWorkerEnvironment(runHome));
    expect(recovery.exit.code).toBe(0);
    expect(recovery.result.ok).toBe(true);
    expect(recovery.result.processId).not.toBe(ready.processId);
    expect(recovery.result.previousState).toBe("UNKNOWN");
    expect(recovery.result.state).toBe("STOPPED");
    expect(recovery.result.stopEvidence).toBe("WINDOWS_JOB_AND_HELPER_ABSENT");
    expect(JSON.stringify(recovery.output)).not.toContain(CANARY);

    const finalDatabase = createSqliteDatabase(databasePath);
    try {
      const finalOwner = getRunProcessOwner(finalDatabase, runId);
      expect(finalOwner?.state).toBe("STOPPED");
      expect(finalOwner?.stopEvidence).toBe("WINDOWS_JOB_AND_HELPER_ABSENT");
      expect(finalOwner?.supervisorPid).toBe(persistedOwner.supervisorPid);
      expect(finalOwner?.supervisorStartIdentity).toBe(persistedOwner.supervisorStartIdentity);
      expect(JSON.stringify({ owners: finalDatabase.all("SELECT * FROM run_process_owners"), runs: finalDatabase.all("SELECT * FROM agent_runs") })).not.toContain(CANARY);
    } finally {
      finalDatabase.close();
    }
    recoverySucceeded = true;
  } catch (error) {
    testError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (ready?.supervisorPid && ready.supervisorStartIdentity) {
      try {
        if (await processExists(ready.supervisorPid)) {
          await runWindowsNativeScopeCommand({
            mode: "terminate-exact",
            processId: ready.supervisorPid,
            expectedCreationTime: ready.supervisorStartIdentity,
          });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (launcher) {
      try {
        await terminateRestartLauncher(launcher, null, 15_000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (descendantPid && descendantCreationTime) {
      try {
        if (await processExists(descendantPid)) {
          await runWindowsNativeScopeCommand({
            mode: "terminate-exact",
            processId: descendantPid,
            expectedCreationTime: descendantCreationTime,
          });
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!recoverySucceeded) {
      try {
        const cleanupPath = join(directory, "cleanup-result.json");
        const cleanup = await runRecoveryWorker(databasePath, runId, cleanupPath, restartWorkerEnvironment(runHome));
        recoverySucceeded = cleanup.exit.code === 0 && cleanup.result.ok === true && cleanup.result.state === "STOPPED";
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!recoverySucceeded) cleanupErrors.push(new Error("WINDOWS_HELPER_CRASH_SCOPE_CLEANUP_UNPROVEN"));
    if (recoverySucceeded) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      cleanupError = new AggregateError(cleanupErrors, "WINDOWS_HELPER_CRASH_SCOPE_CLEANUP_ERRORS");
    }
  }

  if (testError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([testError, cleanupError], "WINDOWS_HELPER_CRASH_TEST_AND_CLEANUP_FAILED");
  }
  if (testError !== undefined) throw testError;
  if (cleanupError !== undefined) throw cleanupError;
}

function restartWorkerEnvironment(runHome: string): Record<string, string> {
  if (isWindows) return { ...windowsChildEnvironment(runHome), NODE_ENV: "test" };
  return { ...managerEnvironment(), NODE_ENV: "test", HERMES_HOME: runHome };
}

function spawnRestartWorker(
  args: string[],
  secret: string | undefined,
  environment: Record<string, string>,
  detached: boolean,
): RestartWorker {
  const child = spawn(process.execPath, ["--import", pathToFileURL(tsxLoader).href, restartChildScript, ...args], {
    cwd: repositoryRoot,
    env: environment,
    detached,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => { output.stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output.stderr += chunk.toString("utf8"); });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  });
  if (secret === undefined) child.stdin.end();
  else child.stdin.end(`${secret}\n`);
  return { child, completion, output };
}

async function terminateRestartLauncher(worker: RestartWorker, processGroupId: number | null | undefined, timeoutMs: number): Promise<void> {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    if (isLinux) {
      const groupId = processGroupId ?? worker.child.pid;
      if (!groupId || groupId <= 0) throw new Error("LINUX_LAUNCHER_PROCESS_GROUP_ID_MISSING");
      try { process.kill(-groupId, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else {
      worker.child.kill("SIGKILL");
    }
  }
  await promiseWithTimeout(worker.completion, timeoutMs, "PROCESS_SCOPE_LAUNCHER_EXIT_TIMEOUT");
}

async function runRecoveryWorker(
  databasePath: string,
  runId: string,
  markerPath: string,
  environment: Record<string, string>,
): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; result: Record<string, unknown>; output: { stdout: string; stderr: string } }> {
  const worker = spawnRestartWorker(["recover", databasePath, runId, "", "", "", "", "", markerPath], undefined, environment, false);
  const exit = await promiseWithTimeout(worker.completion, 60_000, "PROCESS_SCOPE_RECOVERY_EXIT_TIMEOUT");
  let marker: string;
  try { marker = await readFile(markerPath, "utf8"); }
  catch { throw new Error(`PROCESS_SCOPE_RECOVERY_MARKER_MISSING:${exit.code}:${worker.output.stderr}`); }
  const result = JSON.parse(marker) as Record<string, unknown>;
  return { exit, result, output: worker.output };
}

async function runWindowsNativeScopeCommand(options: {
  mode: "is-job-member" | "read-creation" | "terminate-exact";
  processId: number;
  expectedCreationTime?: string;
  containmentId?: string;
}): Promise<ProcessResult> {
  if (!isWindows) throw new Error("WINDOWS_PROCESS_SCOPE_NATIVE_COMMAND_ON_NON_WINDOWS");
  const script = fileURLToPath(new URL("../helpers/windows-process-scope-native.ps1", import.meta.url));
  const args = ["-NoProfile", "-NonInteractive", "-File", script, "-Mode", options.mode, "-ProcessId", String(options.processId)];
  if (options.expectedCreationTime !== undefined) args.push("-ExpectedCreationTime", options.expectedCreationTime);
  if (options.containmentId !== undefined) args.push("-ContainmentId", options.containmentId);
  return new ProcessExecutor().exec("powershell.exe", args, {
    cwd: repositoryRoot,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
}

async function waitForRestartMarker(path: string, worker: RestartWorker, timeoutMs: number): Promise<string> {
  return waitFor(async () => {
    try { return await readFile(path, "utf8"); }
    catch {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        throw new Error(`PROCESS_SCOPE_LAUNCHER_EXITED_BEFORE_READY:${worker.child.exitCode}:${worker.output.stderr}`);
      }
      return undefined;
    }
  }, timeoutMs);
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(reason)), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function readLinuxProcessGroup(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("LINUX_LAUNCHER_PROCESS_STAT_INVALID");
  const fields = stat.slice(close + 1).trim().split(/\s+/u);
  const groupId = Number(fields[2]);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("LINUX_LAUNCHER_PROCESS_GROUP_ID_INVALID");
  return groupId;
}

async function linuxProcessesMatching(fragment: string): Promise<number[]> {
  const entries = await readdir("/proc");
  const matches: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = (await readFile(`/proc/${entry}/cmdline`)).toString("utf8").replaceAll("\0", " ");
      if (command.includes("systemd-run") && command.includes(fragment)) matches.push(Number(entry));
    } catch { /* Process exited while the inventory was read. */ }
  }
  return matches;
}

async function assertLinuxRunnerPrerequisites(executor: ProcessExecutor): Promise<void> {
  const filesystem = await statfs("/sys/fs/cgroup");
  expect(filesystem.type).toBe(0x63677270);
  const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
  expect(controllers.trim().length).toBeGreaterThan(0);
  await access("/sys/fs/cgroup/cgroup.controllers", constants.R_OK);
  const environment = managerEnvironment();
  await executor.exec("systemctl", ["--user", "is-system-running"], { env: environment, timeout: 10_000 });
  await executor.exec("systemctl", ["--user", "show-environment"], { env: environment, timeout: 10_000 });
  await executor.exec("systemd-run", ["--version"], { env: environment, timeout: 5_000 });
  await executor.exec("setsid", ["--version"], { env: environment, timeout: 5_000 });
  await executor.exec("journalctl", ["--version"], { env: environment, timeout: 5_000 });
}

async function showUnitProperties(
  executor: ProcessExecutor,
  unitName: string,
  properties: readonly string[],
): Promise<Map<string, string>> {
  const exactUnitName = unitName.endsWith(".service") ? unitName : `${unitName}.service`;
  const result = await executor.exec("systemctl", [
    "--user", "show", exactUnitName, "--no-pager", ...properties.map((property) => `--property=${property}`),
  ], { env: managerEnvironment(), timeout: 10_000 });
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function managerEnvironment(): Record<string, string> {
  const path = process.env.PATH;
  const runtime = process.env.XDG_RUNTIME_DIR?.replace(/\/+$/, "");
  if (!path || !runtime || !runtime.startsWith("/")) throw new Error("PROCESS_SCOPE_RUNNER_ENVIRONMENT_UNAVAILABLE");
  const environment: Record<string, string> = { PATH: path, HOME: homedir(), XDG_RUNTIME_DIR: runtime };
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (bus !== undefined) {
    const escapedRuntime = runtime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^unix:path=${escapedRuntime}/bus(?:,guid=[a-fA-F0-9]{32})?$`).test(bus)) {
      throw new Error("PROCESS_SCOPE_RUNNER_BUS_ADDRESS_INVALID");
    }
    environment.DBUS_SESSION_BUS_ADDRESS = bus;
  }
  for (const key of ["LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value && /^[A-Za-z0-9_.@-]+$/.test(value)) environment[key] = value;
  }
  return environment;
}

function toScopeIdentity(owner: ReturnType<typeof getRunProcessOwner>): ProcessScopeIdentity {
  if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
  return {
    runId: owner.runId,
    containmentKind: owner.containmentKind,
    containmentId: owner.containmentId,
    launchNonce: owner.launchNonce,
    systemdInvocationId: owner.systemdInvocationId,
    systemdControlGroup: owner.systemdControlGroup,
    supervisorPid: owner.supervisorPid,
    supervisorStartIdentity: owner.supervisorStartIdentity,
    pid: owner.pid,
    platform: owner.platform,
    processStartIdentity: owner.processStartIdentity,
    executableIdentity: owner.executableIdentity,
    state: owner.state,
  };
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<string> {
  return waitFor(async () => {
    try { return await readFile(path, "utf8"); } catch { return undefined; }
  }, timeoutMs);
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PROCESS_SCOPE_ACCEPTANCE_TIMEOUT");
}

async function stopAndPersistIfNeeded(
  database: Database,
  supervisor: SystemdRunSupervisor,
  identity: ProcessScopeIdentity,
): Promise<void> {
  const owner = getRunProcessOwner(database, identity.runId);
  if (!owner || owner.state === "STOPPED") return;
  const observation = await supervisor.inspect(toScopeIdentity(owner));
  if (observation.state === "UNKNOWN") throw new Error(`PROCESS_SCOPE_CLEANUP_UNPROVEN:${observation.reason}`);
  if (observation.state === "LIVE") {
    if (owner.state === "LAUNCHING" || owner.state === "UNKNOWN") {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: owner.runId, expectedState: owner.state, nextState: "LIVE", identity: {
          systemdInvocationId: observation.identity.systemdInvocationId,
          systemdControlGroup: observation.identity.systemdControlGroup,
          pid: observation.identity.pid,
          platform: observation.identity.platform,
        },
      }));
    }
    const live = getRunProcessOwner(database, identity.runId);
    if (!live) throw new Error("RUN_PROCESS_OWNER_MISSING");
    if (live.state === "LIVE") database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: live.runId, expectedState: "LIVE", nextState: "STOPPING",
    }));
    const stopping = getRunProcessOwner(database, identity.runId);
    if (!stopping) throw new Error("RUN_PROCESS_OWNER_MISSING");
    const stopped = await supervisor.stop(toScopeIdentity(stopping));
    if (stopped.state !== "STOPPED") throw new Error("PROCESS_SCOPE_CLEANUP_UNPROVEN");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: stopping.runId, expectedState: "STOPPING", nextState: "STOPPED", evidence: stopped.evidence,
    }));
    return;
  }
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId: owner.runId,
    expectedState: owner.state,
    nextState: "STOPPED",
    evidence: owner.state === "PREPARED" ? "NEVER_LAUNCHED" : observation.evidence,
  }));
}

function windowsChildEnvironment(runHome: string): Record<string, string> {
  const environment: Record<string, string> = { HERMES_HOME: runHome, NODE_ENV: "test" };
  for (const [key, source] of [
    ["PATH", "PATH"], ["SYSTEMROOT", "SystemRoot"], ["TEMP", "TEMP"], ["TMP", "TMP"],
    ["HOMEDRIVE", "HOMEDRIVE"], ["HOMEPATH", "HOMEPATH"],
  ] as const) {
    const value = process.env[source];
    if (value !== undefined) environment[key] = value;
  }
  if (!environment.PATH || !environment.SYSTEMROOT || !environment.TEMP || !environment.TMP) {
    throw new Error("WINDOWS_PROCESS_SCOPE_RUNNER_ENVIRONMENT_UNAVAILABLE");
  }
  return environment;
}

async function stopWindowsScopeIfNeeded(
  database: Database,
  supervisor: WindowsJobSupervisor,
  initialIdentity: ProcessScopeIdentity,
): Promise<void> {
  let owner = getRunProcessOwner(database, initialIdentity.runId);
  if (!owner || owner.state === "STOPPED") return;
  let observation = await supervisor.inspect(toScopeIdentity(owner));
  if (observation.state === "UNKNOWN") throw new Error(`WINDOWS_PROCESS_SCOPE_CLEANUP_UNPROVEN:${observation.reason}`);
  if (observation.state === "STOPPED") {
    const stoppedOwner = owner;
    const evidence = stoppedOwner.state === "PREPARED" ? "NEVER_LAUNCHED" : observation.evidence;
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: stoppedOwner.runId,
      expectedState: stoppedOwner.state,
      nextState: "STOPPED",
      evidence,
    }));
    return;
  }
  if (observation.state !== "LIVE") throw new Error("WINDOWS_PROCESS_SCOPE_CLEANUP_UNPROVEN");
  const liveObservation = observation;
  if (owner.state === "LAUNCHING" || owner.state === "UNKNOWN") {
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: owner!.runId,
      expectedState: owner!.state,
      nextState: "LIVE",
      identity: {
        supervisorPid: liveObservation.identity.supervisorPid,
        supervisorStartIdentity: liveObservation.identity.supervisorStartIdentity,
        pid: liveObservation.identity.pid,
        platform: liveObservation.identity.platform,
        processStartIdentity: liveObservation.identity.processStartIdentity,
        executableIdentity: liveObservation.identity.executableIdentity,
      },
    }));
    owner = getRunProcessOwner(database, initialIdentity.runId);
    if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
    observation = await supervisor.inspect(toScopeIdentity(owner));
    if (observation.state !== "LIVE") throw new Error("WINDOWS_PROCESS_SCOPE_CLEANUP_UNPROVEN");
  }
  if (owner.state === "LIVE") {
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: owner!.runId, expectedState: "LIVE", nextState: "STOPPING",
    }));
    owner = getRunProcessOwner(database, initialIdentity.runId);
    if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
  }
  if (owner.state !== "STOPPING") throw new Error("WINDOWS_PROCESS_SCOPE_STATE_UNEXPECTED");
  const stopped = await supervisor.stop(toScopeIdentity(owner));
  if (stopped.state !== "STOPPED") throw new Error("WINDOWS_PROCESS_SCOPE_CLEANUP_UNPROVEN");
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId: owner!.runId, expectedState: "STOPPING", nextState: "STOPPED", evidence: stopped.evidence,
  }));
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
