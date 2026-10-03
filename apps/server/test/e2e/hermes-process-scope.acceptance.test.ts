import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";
const nativeAcceptanceEnabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const restartChildScript = join(repositoryRoot, "apps/server/test/helpers/hermes-process-scope-restart-child.ts");
const tsxLoader = join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
const WINDOWS_NATIVE_PHASE_MARKERS = [
  "POWERSHELL_INVOCATION_STARTED",
  "POWERSHELL_SCRIPT_STARTED",
  "ADD_TYPE_STARTED",
  "ADD_TYPE_COMPLETED",
  "ASSEMBLY_LOAD_STARTED",
  "ASSEMBLY_LOAD_COMPLETED",
  "OPEN_PROCESS_STARTED",
  "OPEN_PROCESS_RETURNED",
  "GET_PROCESS_TIMES_STARTED",
  "GET_PROCESS_TIMES_RETURNED",
  "POWERSHELL_COMMAND_COMPLETED",
  "CLEANUP_STARTED",
  "CLEANUP_HELPER_TERMINATION_STARTED",
  "CLEANUP_HELPER_TERMINATION_COMPLETED",
  "CLEANUP_HELPER_TERMINATION_FAILED",
  "CLEANUP_LAUNCHER_TERMINATION_STARTED",
  "CLEANUP_LAUNCHER_TERMINATION_COMPLETED",
  "CLEANUP_LAUNCHER_TERMINATION_FAILED",
  "CLEANUP_RECOVERY_WORKER_STARTED",
  "CLEANUP_RECOVERY_WORKER_COMPLETED",
  "CLEANUP_RECOVERY_WORKER_FAILED",
  "CLEANUP_COMPLETED",
  "PHASE_LEDGER_OVERSIZED",
  "PHASE_LEDGER_UNAVAILABLE",
  "PHASE_LEDGER_EMPTY",
] as const;
const WINDOWS_NATIVE_PHASE_MARKER_SET = new Set<string>(WINDOWS_NATIVE_PHASE_MARKERS);
const WINDOWS_NATIVE_PHASE_FILE_LIMIT = 4_096;
const WINDOWS_NATIVE_PHASE_MARKER_LIMIT = 32;
type WindowsNativePhaseMarker = (typeof WINDOWS_NATIVE_PHASE_MARKERS)[number];
let windowsNativeHelperDirectory: string | undefined;
let windowsNativeHelperAssemblyPath: string | undefined;

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

describe("Windows process-scope diagnostic context", () => {
  it("adds native-command context without replacing process error fields", () => {
    const error = Object.assign(new Error("Process timed out after 15000ms"), {
      command: "powershell.exe",
      exitCode: 1,
      stdout: "partial stdout",
      stderr: "partial stderr",
    });

    const context = formatWindowsNativeScopeCommandContext({ mode: "read-creation", processId: 42 }, 15_000, 15_012);
    const contextual = addDiagnosticContext(error, context);

    expect(contextual).toBe(error);
    expect(contextual.message).toContain("mode=read-creation pid=42 timeoutMs=15000 elapsedMs=15012");
    expect(contextual.command).toBe("powershell.exe");
    expect(contextual.exitCode).toBe(1);
    expect(contextual.stdout).toBe("partial stdout");
    expect(contextual.stderr).toBe("partial stderr");
  });

  it("reads only bounded allowlisted native phase markers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ebb-windows-phase-markers-"));
    const markerPath = join(directory, "phases.log");
    try {
      await writeFile(markerPath, [
        "POWERSHELL_INVOCATION_STARTED",
        "untrusted path or output",
        ...Array.from({ length: WINDOWS_NATIVE_PHASE_MARKER_LIMIT + 8 }, () => "OPEN_PROCESS_STARTED"),
      ].join("\n"));

      const markers = await readWindowsNativePhaseMarkers(markerPath);
      expect(markers).toHaveLength(WINDOWS_NATIVE_PHASE_MARKER_LIMIT);
      expect(markers.every((marker) => WINDOWS_NATIVE_PHASE_MARKER_SET.has(marker))).toBe(true);
      expect(markers).not.toContain("untrusted path or output");

      await writeFile(markerPath, "x".repeat(WINDOWS_NATIVE_PHASE_FILE_LIMIT + 1));
      await expect(readWindowsNativePhaseMarkers(markerPath)).resolves.toEqual(["PHASE_LEDGER_OVERSIZED"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("attaches retained phase markers only to read-creation timeouts after cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ebb-windows-phase-snapshot-"));
    const markerPath = join(directory, "phases.log");
    try {
      await writeFile(markerPath, [
        "OPEN_PROCESS_STARTED",
        "GET_PROCESS_TIMES_STARTED",
        "CLEANUP_STARTED",
        "CLEANUP_RECOVERY_WORKER_COMPLETED",
        "CLEANUP_COMPLETED",
      ].join("\n"));
      const snapshot = await readWindowsNativePhaseMarkers(markerPath);
      await rm(directory, { recursive: true, force: true });

      const readCreationError = addDiagnosticContext(
        new Error("Process timed out after 15000ms"),
        formatWindowsNativeScopeCommandContext({ mode: "read-creation", processId: 42 }, 15_000, 15_012),
      );
      expect(isWindowsNativeReadCreationTimeout(readCreationError)).toBe(true);
      const enrichedReadCreationError = addWindowsNativePhaseContext(readCreationError, snapshot);
      expect(enrichedReadCreationError.message).toContain(
        "WINDOWS_NATIVE_PHASE_MARKERS=OPEN_PROCESS_STARTED,GET_PROCESS_TIMES_STARTED,CLEANUP_STARTED,CLEANUP_RECOVERY_WORKER_COMPLETED,CLEANUP_COMPLETED",
      );

      for (const mode of ["is-job-member", "terminate-exact"] as const) {
        const otherModeError = addDiagnosticContext(
          new Error("Process timed out after 15000ms"),
          formatWindowsNativeScopeCommandContext({ mode, processId: 42 }, 15_000, 15_012),
        );
        expect(isWindowsNativeReadCreationTimeout(otherModeError)).toBe(false);
        expect(otherModeError.message).not.toContain("WINDOWS_NATIVE_PHASE_MARKERS=");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Windows native helper assembly cache contract", () => {
  it("compiles once into an isolated temporary assembly and loads it for native operations", async () => {
    const helperPath = fileURLToPath(new URL("../helpers/windows-process-scope-native.ps1", import.meta.url));
    const helperSource = await readFile(helperPath, "utf8");
    const testSource = await readFile(fileURLToPath(import.meta.url), "utf8");

    expect(helperSource).toContain('"compile-helper"');
    expect(helperSource).toContain("Add-Type -TypeDefinition $nativeMethods -OutputAssembly $resolvedAssemblyPath");
    expect(helperSource).toContain("Add-Type -Path $resolvedAssemblyPath");
    expect(helperSource.match(/Add-Type\s+-TypeDefinition/gu)).toHaveLength(1);
    expect(testSource).toContain('await mkdtemp(join(tmpdir(), "ebb-windows-native-helper-"))');
    expect(testSource).toContain('args.push("-AssemblyPath", windowsNativeHelperAssemblyPath)');
    expect(testSource.match(/await compileWindowsNativeHelper\(\);/gu)).toHaveLength(1);
    expect(testSource).toMatch(/afterAll\(async \(\) => \{[\s\S]*?await rm\(windowsNativeHelperDirectory, \{ recursive: true, force: true \}\)/u);
    expect(testSource).toContain("const timeoutMs = 15_000");
  });
});

describe("Linux process-scope diagnostic formatting", () => {
  it("bounds and redacts process completion output while reporting available signal data", () => {
    const result = {
      exitCode: 23,
      stdout: `API_KEY=private-value ${"x".repeat(4_000)}`,
      stderr: "Bearer private-token",
    };
    const completion = formatProcessCompletionDiagnostic(result);

    expect(completion).toContain("exitCode=23");
    expect(completion).toContain("signal=unavailable (ProcessResult does not expose it)");
    expect(completion).not.toContain("private-value");
    expect(completion).not.toContain("private-token");
    expect(completion).toContain("[truncated]");
    expect(completion.length).toBeLessThan(3_000);

    const signaled = formatProcessCompletionDiagnostic({
      ...result,
      signal: "SIGTERM",
    } as ProcessResult & { signal: string });
    expect(signaled).toContain("signal=SIGTERM");
  });

  it("formats only the explicitly allowed systemd properties", () => {
    const formatted = formatLinuxUnitProperties([
      "ActiveState=active",
      "Environment=API_KEY=private-value",
      "ExecStart=/usr/bin/node secret-argument",
      "Result=success",
    ].join("\n"));

    expect(formatted).toContain("ActiveState=active");
    expect(formatted).toContain("Result=success");
    expect(formatted).not.toContain("Environment");
    expect(formatted).not.toContain("ExecStart");
    expect(formatted).not.toContain("private-value");
  });

  it("reports the process result when completion wins before the payload marker", async () => {
    const processHandle: ProcessScopeHandle = {
      completion: Promise.resolve({ exitCode: 23, stdout: "payload stdout", stderr: "payload stderr" }),
    };
    const error = await waitForPayloadMarker(
      join(tmpdir(), `ebb-marker-never-created-${randomUUID()}`),
      processHandle,
      "ebb-orchestrator-run-test",
      new ProcessExecutor(),
      1_000,
    ).then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("PROCESS_SCOPE_PAYLOAD_COMPLETED_BEFORE_MARKER");
    expect((error as Error).message).toContain("exitCode=23");
    expect((error as Error).message).toContain("stdout=\"payload stdout\"");
    expect((error as Error).message).toContain("stderr=\"payload stderr\"");
  });

  it("includes bounded unit diagnostics and preserves the cause when process completion rejects", async () => {
    const executor = new ProcessExecutor();
    const failure = new Error("PROCESS_SCOPE_STOP_UNPROVEN");
    const environmentKeys = ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
    const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    const execSpy = vi.spyOn(executor, "exec").mockImplementation(async (file) => ({
      exitCode: 0,
      stdout: file === "systemctl"
        ? "ActiveState=failed\nResult=timeout\nEnvironment=API_KEY=private-value\n"
        : "systemd journal diagnostic tail",
      stderr: "",
    }));
    process.env.PATH = process.env.PATH ?? "/usr/bin";
    process.env.XDG_RUNTIME_DIR = "/run/user/1002";
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const error = await waitForPayloadMarker(
        join(tmpdir(), `ebb-marker-never-created-${randomUUID()}`),
        { completion: Promise.reject(failure) },
        "ebb-orchestrator-run-test",
        executor,
        1_000,
      ).then(() => undefined, (reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("PROCESS_SCOPE_COMPLETION_REJECTED_BEFORE_MARKER");
      expect((error as Error).message).toContain("ActiveState=failed");
      expect((error as Error).message).toContain("Result=timeout");
      expect((error as Error).message).toContain("systemd journal diagnostic tail");
      expect((error as Error).message).not.toContain("private-value");
      expect((error as Error & { cause?: unknown }).cause).toBe(failure);
      expect(execSpy).toHaveBeenCalledTimes(2);
    } finally {
      execSpy.mockRestore();
      for (const key of environmentKeys) {
        const value = originalEnvironment.get(key);
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
    const payloadMarkerPath = join(directory, "payload-provider-free.txt");
    const descendantPidPath = join(directory, "setsid-descendant.pid");
    const wrapperPidPath = join(directory, "wrapper.pid");
    const payloadReleasePath = join(directory, "payload.release");
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
      "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
      "if (process.env.EBB_HERMES_PROVIDER_API_KEY) process.exit(20);",
      "const wrapperEntries = readFileSync(`/proc/${process.ppid}/environ`, 'utf8').split('\\0').filter(Boolean);",
      "const wrapperKeys = new Set(wrapperEntries.map((entry) => entry.slice(0, entry.indexOf('='))));",
      "const allowedWrapperKeys = new Set(['PATH', 'HOME', 'HERMES_HOME', 'NODE_ENV']);",
      "if (wrapperEntries.some((entry) => !allowedWrapperKeys.has(entry.slice(0, entry.indexOf('='))))) process.exit(22);",
      "if ([...allowedWrapperKeys].some((key) => !wrapperKeys.has(key))) process.exit(23);",
      "if (wrapperEntries.some((entry) => entry.startsWith('EBB_HERMES_PROVIDER_API_KEY='))) process.exit(24);",
      "writeFileSync(process.argv[1], 'provider-free-dummy-payload');",
      "const child = spawn('setsid', ['/bin/sh', '-c', 'sleep 60'], { stdio: 'ignore' });",
      "child.once('error', () => process.exit(21));",
      "child.once('spawn', () => { writeFileSync(process.argv[2], String(child.pid)); writeFileSync(process.argv[3], String(process.ppid)); process.stdout.write('dummy payload stdout canary\\n'); process.stderr.write('dummy payload stderr canary\\n'); const releaseCheck = setInterval(() => { if (existsSync(process.argv[4])) { clearInterval(releaseCheck); child.unref(); process.exit(0); } }, 20); });",
    ].join(" ");
    handle = await supervisor.launch(scopeIdentity, {
      executable: process.execPath,
      args: ["-e", payload, payloadMarkerPath, descendantPidPath, wrapperPidPath, payloadReleasePath],
      cwd: directory,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: homedir(),
        HERMES_HOME: runHome,
        NODE_ENV: "test",
      },
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
    const payloadMarker = await waitForPayloadMarker(payloadMarkerPath, handle, unitName, executor);
    const descendantPid = Number(await waitForFile(descendantPidPath));
    const wrapperPid = Number(await waitForFile(wrapperPidPath));
    expect(payloadMarker).toBe("provider-free-dummy-payload");
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    expect(Number.isSafeInteger(wrapperPid)).toBe(true);
    expect(wrapperPid).toBeGreaterThan(0);

    const runningProperties = await showUnitProperties(executor, unitName, ["MainPID", "ControlGroup", "ActiveState"]);
    expect(runningProperties.get("MainPID")).toBe(String(wrapperPid));
    expect(runningProperties.get("ControlGroup")).toBe(persistedOwner?.systemdControlGroup);
    expect(runningProperties.get("ActiveState")).toBe("active");
    await writeFile(payloadReleasePath, "release");

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
    expect(requiredProperties.has("Environment")).toBe(true);
    const environmentContainsProviderKey = (requiredProperties.get("Environment") ?? "")
      .includes("EBB_HERMES_PROVIDER_API_KEY");
    expect(environmentContainsProviderKey).toBe(false);

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
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
    expect(completion.stdout).toContain("dummy payload stdout canary");
    expect(completion.stderr).toContain("dummy payload stderr canary");

    const journal = await executor.exec("journalctl", ["--user", "--unit", `${unitName}.service`, "--no-pager", "--output=cat"], {
      env: managerEnvironment(), timeout: 10_000,
    });
    expect(`${journal.stdout}\n${journal.stderr}`).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
    expect(JSON.stringify({
      runs: database.all("SELECT * FROM agent_runs"),
      owners: database.all("SELECT * FROM run_process_owners"),
    })).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "ebb-windows-native-helper-"));
    windowsNativeHelperDirectory = directory;
    windowsNativeHelperAssemblyPath = join(directory, "EbbProcessScopeNative.dll");
    try {
      await compileWindowsNativeHelper();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      windowsNativeHelperDirectory = undefined;
      windowsNativeHelperAssemblyPath = undefined;
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    if (!windowsNativeHelperDirectory) return;
    await rm(windowsNativeHelperDirectory, { recursive: true, force: true });
    windowsNativeHelperDirectory = undefined;
    windowsNativeHelperAssemblyPath = undefined;
  });

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
      args: ["-e", "if (process.env.EBB_HERMES_PROVIDER_API_KEY) process.exit(20); process.exit(0)"],
      cwd: directory,
      environment: windowsChildEnvironment(runHome),
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
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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
    const payloadMarkerPath = join(directory, "payload-provider-free.txt");
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
      "const fs=require('node:fs');",
      "if(process.env.EBB_HERMES_PROVIDER_API_KEY)process.exit(20);",
      `fs.writeFileSync(${JSON.stringify(payloadMarkerPath)},'provider-free-dummy-payload');`,
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
    expect(await waitForFile(payloadMarkerPath)).toBe("provider-free-dummy-payload");
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
    expect(`${completion.stdout}\n${completion.stderr}`).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
    const finalHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await readFile(heartbeatPath, "utf8")).toBe(finalHeartbeat);
    expect(JSON.stringify({
      runs: database.all("SELECT * FROM agent_runs"),
      owners: database.all("SELECT * FROM run_process_owners"),
    })).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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
  const payloadMarkerPath = join(directory, "payload-provider-free.txt");
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
      "launch", databasePath, runId, runHome, heartbeatPath, payloadMarkerPath,
      descendantPidPath, descendantExitPath, readyPath,
    ];
    const launcherEnvironment = restartWorkerEnvironment(runHome);
    launcher = spawnRestartWorker(launchArgs, launcherEnvironment, isLinux);

    ready = JSON.parse(await waitForRestartMarker(readyPath, launcher, 60_000)) as RestartMarker;
    expect(ready.runId).toBe(runId);
    expect(ready.processId).toBe(launcher.child.pid);
    expect(ready.state).toBe(isWindows ? "UNKNOWN" : "LIVE");
    expect(await waitForFile(payloadMarkerPath)).toBe("provider-free-dummy-payload");
    const descendantPid = Number(await waitForFile(descendantPidPath));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(descendantPid).toBeGreaterThan(0);
    expect(JSON.stringify(launcher.output)).not.toContain("EBB_HERMES_PROVIDER_API_KEY");

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
    expect(JSON.stringify(launcher.output)).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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
    expect(JSON.stringify(recovery.output)).not.toContain("EBB_HERMES_PROVIDER_API_KEY");

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
      expect(`${journal.stdout}\n${journal.stderr}`).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
      const clientPids = await linuxProcessesMatching(unitName!);
      expect(clientPids).toEqual([]);
    }

    const finalDatabase = createSqliteDatabase(databasePath);
    try {
      const finalOwner = getRunProcessOwner(finalDatabase, runId);
      expect(finalOwner?.state).toBe("STOPPED");
      expect(JSON.stringify({ owners: finalDatabase.all("SELECT * FROM run_process_owners"), runs: finalDatabase.all("SELECT * FROM agent_runs") }))
        .not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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
  const windowsNativePhasePath = join(directory, "windows-native-phases.log");
  const databasePath = join(directory, "state.sqlite");
  const runId = randomUUID();
  const runHome = join(directory, "hermes-home");
  const payloadMarkerPath = join(directory, "payload-provider-free.txt");
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
  let windowsNativePhaseSnapshot: WindowsNativePhaseMarker[] | undefined;

  try {
    const launchArgs = [
      "launch", databasePath, runId, runHome, heartbeatPath, payloadMarkerPath,
      descendantPidPath, descendantExitPath, readyPath,
    ];
    launcher = spawnRestartWorker(launchArgs, restartWorkerEnvironment(runHome), false);
    ready = JSON.parse(await waitForRestartMarker(readyPath, launcher, 60_000)) as RestartMarker;
    expect(ready.runId).toBe(runId);
    expect(ready.processId).toBe(launcher.child.pid);
    expect(ready.platform).toBe("win32");
    expect(ready.state).toBe("UNKNOWN");
    if (!ready.supervisorPid || !ready.supervisorStartIdentity || !ready.containmentId) {
      throw new Error("WINDOWS_PERSISTED_HELPER_IDENTITY_MISSING");
    }

    expect(await waitForFile(payloadMarkerPath)).toBe("provider-free-dummy-payload");
    const launchedDescendantPid = Number(await waitForFile(descendantPidPath));
    descendantPid = launchedDescendantPid;
    expect(Number.isSafeInteger(launchedDescendantPid)).toBe(true);
    expect(launchedDescendantPid).toBeGreaterThan(0);
    const descendantIdentity = await runWindowsNativeScopeCommand({
      mode: "read-creation",
      processId: launchedDescendantPid,
      diagnosticPath: windowsNativePhasePath,
    });
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
      else mismatchedIdentityError = error instanceof Error ? error.message : String(error);
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
    expect(JSON.stringify(recovery.output)).not.toContain("EBB_HERMES_PROVIDER_API_KEY");

    const finalDatabase = createSqliteDatabase(databasePath);
    try {
      const finalOwner = getRunProcessOwner(finalDatabase, runId);
      expect(finalOwner?.state).toBe("STOPPED");
      expect(finalOwner?.stopEvidence).toBe("WINDOWS_JOB_AND_HELPER_ABSENT");
      expect(finalOwner?.supervisorPid).toBe(persistedOwner.supervisorPid);
      expect(finalOwner?.supervisorStartIdentity).toBe(persistedOwner.supervisorStartIdentity);
      expect(JSON.stringify({ owners: finalDatabase.all("SELECT * FROM run_process_owners"), runs: finalDatabase.all("SELECT * FROM agent_runs") }))
        .not.toContain("EBB_HERMES_PROVIDER_API_KEY");
    } finally {
      finalDatabase.close();
    }
    recoverySucceeded = true;
  } catch (error) {
    testError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_STARTED");
    if (!recoverySucceeded && ready?.supervisorPid && ready.supervisorStartIdentity) {
      try {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_HELPER_TERMINATION_STARTED");
        if (await processExists(ready.supervisorPid)) {
          await runWindowsNativeScopeCommand({
            mode: "terminate-exact",
            processId: ready.supervisorPid,
            expectedCreationTime: ready.supervisorStartIdentity,
          });
        }
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_HELPER_TERMINATION_COMPLETED");
      } catch (error) {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_HELPER_TERMINATION_FAILED");
        cleanupErrors.push(addDiagnosticContext(error, `WINDOWS_CLEANUP operation=terminate-helper-exact pid=${ready.supervisorPid}`));
      }
    }
    if (launcher) {
      try {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_LAUNCHER_TERMINATION_STARTED");
        await terminateRestartLauncher(launcher, null, 15_000);
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_LAUNCHER_TERMINATION_COMPLETED");
      } catch (error) {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_LAUNCHER_TERMINATION_FAILED");
        cleanupErrors.push(addDiagnosticContext(error, `WINDOWS_CLEANUP operation=terminate-launcher pid=${launcher.child.pid ?? "unavailable"}`));
      }
    }
    if (!recoverySucceeded && descendantPid && descendantCreationTime) {
      try {
        if (await processExists(descendantPid)) {
          await runWindowsNativeScopeCommand({
            mode: "terminate-exact",
            processId: descendantPid,
            expectedCreationTime: descendantCreationTime,
          });
        }
      } catch (error) {
        cleanupErrors.push(addDiagnosticContext(error, `WINDOWS_CLEANUP operation=terminate-descendant-exact pid=${descendantPid}`));
      }
    }
    if (!recoverySucceeded) {
      try {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_RECOVERY_WORKER_STARTED");
        const cleanupPath = join(directory, "cleanup-result.json");
        const cleanup = await runRecoveryWorker(databasePath, runId, cleanupPath, restartWorkerEnvironment(runHome));
        recoverySucceeded = cleanup.exit.code === 0 && cleanup.result.ok === true && cleanup.result.state === "STOPPED";
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_RECOVERY_WORKER_COMPLETED");
      } catch (error) {
        await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_RECOVERY_WORKER_FAILED");
        cleanupErrors.push(addDiagnosticContext(error, "WINDOWS_CLEANUP operation=run-recovery-worker"));
      }
    }
    if (!recoverySucceeded) cleanupErrors.push(new Error("WINDOWS_HELPER_CRASH_SCOPE_CLEANUP_UNPROVEN operation=verify-recovery-stop"));
    await appendWindowsNativePhase(windowsNativePhasePath, "CLEANUP_COMPLETED");
    windowsNativePhaseSnapshot = await readWindowsNativePhaseMarkers(windowsNativePhasePath);
    if (recoverySucceeded) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(addDiagnosticContext(error, "WINDOWS_CLEANUP operation=remove-test-directory"));
      }
    }
    if (cleanupErrors.length > 0) {
      cleanupError = new AggregateError(cleanupErrors, "WINDOWS_HELPER_CRASH_SCOPE_CLEANUP_ERRORS");
    }
  }

  if (isWindowsNativeReadCreationTimeout(testError)) {
    const phaseMarkers = windowsNativePhaseSnapshot ?? await readWindowsNativePhaseMarkers(windowsNativePhasePath);
    testError = addWindowsNativePhaseContext(testError, phaseMarkers);
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
  child.stdin.end();
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
  const worker = spawnRestartWorker(["recover", databasePath, runId, "", "", "", "", "", markerPath], environment, false);
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
  diagnosticPath?: string;
}): Promise<ProcessResult> {
  if (!isWindows) throw new Error("WINDOWS_PROCESS_SCOPE_NATIVE_COMMAND_ON_NON_WINDOWS");
  const script = fileURLToPath(new URL("../helpers/windows-process-scope-native.ps1", import.meta.url));
  const args = ["-NoProfile", "-NonInteractive", "-File", script, "-Mode", options.mode, "-ProcessId", String(options.processId)];
  if (!windowsNativeHelperAssemblyPath) throw new Error("WINDOWS_NATIVE_HELPER_ASSEMBLY_NOT_INITIALIZED");
  args.push("-AssemblyPath", windowsNativeHelperAssemblyPath);
  if (options.expectedCreationTime !== undefined) args.push("-ExpectedCreationTime", options.expectedCreationTime);
  if (options.containmentId !== undefined) args.push("-ContainmentId", options.containmentId);
  if (options.diagnosticPath !== undefined) args.push("-DiagnosticPath", options.diagnosticPath);
  const timeoutMs = 15_000;
  const startedAt = Date.now();
  if (options.diagnosticPath !== undefined) {
    await appendWindowsNativePhase(options.diagnosticPath, "POWERSHELL_INVOCATION_STARTED");
  }
  try {
    const result = await new ProcessExecutor().exec("powershell.exe", args, {
      cwd: repositoryRoot,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    if (options.diagnosticPath !== undefined) {
      await appendWindowsNativePhase(options.diagnosticPath, "POWERSHELL_COMMAND_COMPLETED");
    }
    return result;
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    throw addDiagnosticContext(error, formatWindowsNativeScopeCommandContext(options, timeoutMs, elapsedMs));
  }
}

async function compileWindowsNativeHelper(): Promise<void> {
  if (!isWindows) throw new Error("WINDOWS_NATIVE_HELPER_COMPILE_ON_NON_WINDOWS");
  if (!windowsNativeHelperDirectory || !windowsNativeHelperAssemblyPath) {
    throw new Error("WINDOWS_NATIVE_HELPER_TEMP_DIRECTORY_NOT_INITIALIZED");
  }
  const script = fileURLToPath(new URL("../helpers/windows-process-scope-native.ps1", import.meta.url));
  const result = await new ProcessExecutor().exec("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", script,
    "-Mode", "compile-helper", "-ProcessId", "0", "-AssemblyPath", windowsNativeHelperAssemblyPath,
  ], {
    cwd: repositoryRoot,
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  });
  if (result.stdout.trim() !== "NATIVE_HELPER_COMPILED") {
    throw new Error(`WINDOWS_NATIVE_HELPER_COMPILE_MARKER_MISSING:${result.stdout.trim()}`);
  }
  await access(windowsNativeHelperAssemblyPath);
}

async function appendWindowsNativePhase(path: string, phase: WindowsNativePhaseMarker): Promise<void> {
  if (!WINDOWS_NATIVE_PHASE_MARKER_SET.has(phase)) return;
  try {
    const file = await open(path, "a");
    try {
      const bytes = Buffer.from(`${phase}\n`, "utf8");
      if ((await file.stat()).size + bytes.byteLength <= WINDOWS_NATIVE_PHASE_FILE_LIMIT) await file.write(bytes);
    } finally { await file.close(); }
  } catch { /* Diagnostics must not alter acceptance behavior. */ }
}

async function readWindowsNativePhaseMarkers(path: string): Promise<WindowsNativePhaseMarker[]> {
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, "r"); }
  catch { return ["PHASE_LEDGER_UNAVAILABLE"]; }
  try {
    const buffer = Buffer.alloc(WINDOWS_NATIVE_PHASE_FILE_LIMIT + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > WINDOWS_NATIVE_PHASE_FILE_LIMIT) return ["PHASE_LEDGER_OVERSIZED"];
    const markers = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u)
      .filter((line): line is WindowsNativePhaseMarker => WINDOWS_NATIVE_PHASE_MARKER_SET.has(line));
    return markers.slice(-WINDOWS_NATIVE_PHASE_MARKER_LIMIT);
  } catch {
    return ["PHASE_LEDGER_UNAVAILABLE"];
  } finally {
    await file.close().catch(() => undefined);
  }
}

function addWindowsNativePhaseContext(error: Error, markers: readonly WindowsNativePhaseMarker[]): Error {
  return addDiagnosticContext(error, `WINDOWS_NATIVE_PHASE_MARKERS=${markers.join(",") || "PHASE_LEDGER_EMPTY"}`);
}

function isWindowsNativeReadCreationTimeout(error: unknown): error is Error {
  return error instanceof Error
    && error.message.startsWith("WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=read-creation ")
    && error.message.includes(": Process timed out after 15000ms");
}

function formatWindowsNativeScopeCommandContext(
  options: { mode: "is-job-member" | "read-creation" | "terminate-exact"; processId?: number },
  timeoutMs: number,
  elapsedMs: number,
): string {
  const pid = options.processId === undefined ? "unavailable" : String(options.processId);
  return `WINDOWS_NATIVE_SCOPE_COMMAND_FAILED mode=${options.mode} pid=${pid} timeoutMs=${timeoutMs} elapsedMs=${elapsedMs}`;
}

/** Добавляет контекст тестового process-scope вызова, сохраняя исходный error и его поля stdout/stderr. */
function addDiagnosticContext<T extends Error>(error: T, context: string): T;
function addDiagnosticContext(error: unknown, context: string): Error;
function addDiagnosticContext(error: unknown, context: string): Error {
  if (!(error instanceof Error)) return new Error(`${context}: ${String(error)}`, { cause: error });
  const previousMessage = error.message;
  error.message = `${context}: ${previousMessage}`;
  if (error.stack) error.stack = error.stack.replace(previousMessage, error.message);
  return error;
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

const LINUX_ACCEPTANCE_DIAGNOSTIC_PROPERTIES = [
  "ActiveState", "SubState", "MainPID", "ControlGroup", "Result", "ExecMainCode", "ExecMainStatus", "InvocationID",
] as const;
const PROCESS_COMPLETION_STREAM_LIMIT = 1_200;
const LINUX_UNIT_DIAGNOSTIC_LIMIT = 10_000;

async function waitForPayloadMarker(
  path: string,
  processHandle: ProcessScopeHandle,
  unitName: string,
  executor: ProcessExecutor,
  timeoutMs = 30_000,
): Promise<string> {
  const markerWait = waitForFile(path, timeoutMs).then(
    (value) => ({ kind: "marker" as const, value }),
    (error: unknown) => ({ kind: "timeout" as const, error }),
  );
  const completionWait = processHandle.completion.then(
    async (result) => {
      const marker = await readFileIfPresent(path);
      return marker === undefined
        ? { kind: "completed" as const, result }
        : { kind: "marker" as const, value: marker };
    },
    async (error: unknown) => {
      const marker = await readFileIfPresent(path);
      return marker === undefined
        ? { kind: "completion-error" as const, error }
        : { kind: "marker" as const, value: marker };
    },
  );

  const outcome = await Promise.race([markerWait, completionWait]);
  if (outcome.kind === "marker") return outcome.value;
  if (outcome.kind === "completed") {
    throw new Error(formatProcessCompletionDiagnostic(outcome.result), {
      cause: new Error("PROCESS_SCOPE_PAYLOAD_COMPLETED_BEFORE_MARKER"),
    });
  }
  if (outcome.kind === "completion-error") {
    let diagnostics: string;
    try {
      diagnostics = await collectLinuxUnitDiagnostics(executor, unitName);
    } catch (error) {
      diagnostics = `unit diagnostics unavailable: ${formatDiagnosticError(error)}`;
    }
    throw new Error(
      `PROCESS_SCOPE_COMPLETION_REJECTED_BEFORE_MARKER: ${formatDiagnosticError(outcome.error)}\n${diagnostics}`,
      {
        cause: outcome.error,
      },
    );
  }

  let diagnostics: string;
  try {
    diagnostics = await collectLinuxUnitDiagnostics(executor, unitName);
  } catch (error) {
    diagnostics = `unit diagnostics unavailable: ${formatDiagnosticError(error)}`;
  }
  throw new Error(`PROCESS_SCOPE_PAYLOAD_MARKER_TIMEOUT\n${diagnostics}`, { cause: outcome.error });
}

async function collectLinuxUnitDiagnostics(executor: ProcessExecutor, unitName: string): Promise<string> {
  const exactUnitName = unitName.endsWith(".service") ? unitName : `${unitName}.service`;
  const [properties, journal] = await Promise.all([
    executor.exec("systemctl", [
      "--user", "show", exactUnitName, "--no-pager",
      ...LINUX_ACCEPTANCE_DIAGNOSTIC_PROPERTIES.map((property) => `--property=${property}`),
    ], { env: managerEnvironment(), timeout: 5_000, maxBuffer: 6_000 })
      .then((result) => formatLinuxUnitProperties(result.stdout))
      .catch((error: unknown) => `unavailable: ${formatDiagnosticError(error)}`),
    executor.exec("journalctl", [
      "--user", `--unit=${exactUnitName}`, "--no-pager", "--output=short-iso", "--lines=40",
    ], { env: managerEnvironment(), timeout: 5_000, maxBuffer: 8_000 })
      .then((result) => boundedDiagnosticText(result.stdout, 6_000))
      .catch((error: unknown) => `unavailable: ${formatDiagnosticError(error)}`),
  ]);
  return boundedDiagnosticText([
    `unit=${exactUnitName}`,
    "properties:", properties || "(no allowlisted properties returned)",
    "journal tail (last 40 lines):", journal || "(empty)",
  ].join("\n"), LINUX_UNIT_DIAGNOSTIC_LIMIT);
}

function formatLinuxUnitProperties(output: string): string {
  const allowed = new Set<string>(LINUX_ACCEPTANCE_DIAGNOSTIC_PROPERTIES);
  const lines: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (!allowed.has(name)) continue;
    lines.push(`${name}=${boundedDiagnosticText(line.slice(separator + 1), 512)}`);
  }
  return lines.join("\n");
}

function formatProcessCompletionDiagnostic(result: ProcessResult): string {
  const signal = (result as ProcessResult & { signal?: unknown }).signal;
  const signalText = typeof signal === "string" && /^[A-Z0-9]+$/u.test(signal)
    ? signal
    : "unavailable (ProcessResult does not expose it)";
  return [
    "PROCESS_SCOPE_PAYLOAD_COMPLETED_BEFORE_MARKER",
    `exitCode=${result.exitCode}`,
    `signal=${signalText}`,
    `stdout=${JSON.stringify(boundedDiagnosticText(result.stdout, PROCESS_COMPLETION_STREAM_LIMIT))}`,
    `stderr=${JSON.stringify(boundedDiagnosticText(result.stderr, PROCESS_COMPLETION_STREAM_LIMIT))}`,
  ].join("\n");
}

function formatDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return boundedDiagnosticText(`${error.name}: ${error.message}`, 1_000);
  }
  return boundedDiagnosticText(String(error), 1_000);
}

function boundedDiagnosticText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*([=:])\s*([^\s,;]+)/giu, "$1$2[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_KEY]");
  const sanitized = Array.from(redacted, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f
      ? " "
      : character;
  }).join("");
  if (sanitized.length <= maxLength) return sanitized;
  const suffix = "[truncated]";
  return `${sanitized.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
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
