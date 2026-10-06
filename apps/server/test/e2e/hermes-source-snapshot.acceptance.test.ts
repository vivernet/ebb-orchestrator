import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createHermesLaunchTicket, type HermesLaunchObjectIdentity, type HermesLaunchTicket } from "../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { ensureHermesSourceSnapshotNativeProjection, materializeHermesSourceSnapshot } from "../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { acquireHermesSourceReferenceLock } from "../../src/modules/runtime/hermes/hermes-source-reference-lock.js";
import { prepareRunProcessOwner } from "../../src/modules/runtime/run-process-owner.js";
import { ProcessExecutor, type ProcessResult } from "../../src/platform/process/process-executor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../src/platform/process/process-inspector.js";
import type { ProcessScopeHandle, ProcessScopeSupervisor } from "../../src/platform/process/run-scope-supervisor.js";
import { createWindowsNativeHelperInvocation } from "../../src/platform/process/windows-native-helper-launcher.js";
import { createPinnedGitFixture, waitForFile } from "../helpers/hermes-source-snapshot-acceptance-fixture.js";

const enabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";
const windows = process.platform === "win32";
const linux = process.platform === "linux";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const helperDirectory = resolve(repositoryRoot, "apps/server/dist/native/hermes-profile-path");
const windowsSupervisorPath = resolve(repositoryRoot, "apps/server/dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
const linuxLauncherPath = resolve(repositoryRoot, "apps/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher");
const profileHelperPath = join(helperDirectory, windows ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path");
const PINNED_VERSION = "v0.21.5+7357.g9244275";
const SOURCE_MARKER = "snapshot-pinned-v1";
const SOURCE_RESOURCE = "snapshot-resource-pinned-v1";

describe.skipIf(!enabled || (!windows && !linux))("Hermes native source snapshot acceptance", () => {
  const executor = new ProcessExecutor();
  const supervisor: ProcessScopeSupervisor = windows
    ? new WindowsJobSupervisor(executor, windowsSupervisorPath)
    : new SystemdRunSupervisor(executor, { linuxHermesLauncherPath: linuxLauncherPath });
  let fixtureDirectory = "";
  let fixtureDirectoryIdentity: HermesLaunchObjectIdentity | undefined;
  let cleanupBlocked = false;

  afterAll(async () => {
    if (!fixtureDirectory) return;
    if (cleanupBlocked) throw new Error(`SOURCE_ACCEPTANCE_FIXTURE_RETAINED_STOP_NOT_PROVEN:${fixtureDirectory}`);
    const currentIdentity = await objectIdentity(fixtureDirectory, "directory");
    if (!fixtureDirectoryIdentity || !sameObjectIdentity(currentIdentity, fixtureDirectoryIdentity)) {
      throw new Error(`SOURCE_ACCEPTANCE_FIXTURE_IDENTITY_CHANGED_RETAINED:${fixtureDirectory}`);
    }
    let cleanupStage = "make-removable";
    try {
      await makeFixtureRemovable(fixtureDirectory);
      cleanupStage = "recursive-remove";
      await rm(fixtureDirectory, { recursive: true, force: true });
      cleanupStage = "verify-removed";
      try {
        await lstat(fixtureDirectory);
        throw new Error("SOURCE_ACCEPTANCE_FIXTURE_ROOT_STILL_EXISTS");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    } catch (error) {
      throw new Error(`SOURCE_ACCEPTANCE_FIXTURE_CLEANUP_FAILED:${cleanupStage}:${safeErrorCode(error)}`, { cause: error });
    }
    fixtureDirectory = "";
    fixtureDirectoryIdentity = undefined;
  });

  it("verifies EHSP before dispatch, pins imports, and holds the exact native scope and cache lease", async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "ebb-hermes-source-acceptance-"));
    fixtureDirectoryIdentity = await objectIdentity(fixtureDirectory, "directory");
    const fixture = await createPinnedGitFixture(fixtureDirectory);
    const cacheRoot = join(fixtureDirectory, "source-cache");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const snapshot = await materializeHermesSourceSnapshot({
        gitExecutable: await resolveGit(), sourceRoot: fixture.sourceRoot, cacheRoot,
        hermesVersion: PINNED_VERSION, commit: fixture.commit, tree: fixture.tree,
      });
      await writeFile(fixture.originalResourcePath, "checkout-resource-mutated-v2\n", { encoding: "utf8" });
      const projectionResult = await ensureHermesSourceSnapshotNativeProjection({ cacheRoot, cacheKey: snapshot.cacheKey });
      const acceptedSnapshot = projectionResult.snapshot;
      const { projection } = projectionResult;
      expect(await snapshotContainsPycache(snapshot.rootPath)).toBe(false);
    const originalProjection = await readFile(projection.path);
    let primaryFailure: unknown;
    let cleanupFailure: unknown;

    try {
      for (const variant of ["changed", "missing", "extra", "hash", "malformed"] as const) {
        await replaceProjection(projection.path, originalProjection, variant);
        const refusal = await launchAndAssertRefused({
          fixtureDirectory, snapshot: acceptedSnapshot, projectionPath: projection.path,
          expectedProjection: variant === "missing" ? originalProjection : await readFile(projection.path),
          supervisor, onUnprovenStop: () => { cleanupBlocked = true; },
        });
        expect(refusal.observation.state, `${variant} EHSP must be refused by the native parser`).toBe("STOPPED");
        expect(await markerExists(refusal.markerPath), `${variant} EHSP must be refused before payload dispatch`).toBe(false);
        if (variant === "missing") await writeProjection(projection.path, originalProjection);
      }
      await writeProjection(projection.path, originalProjection);

      const runId = randomUUID();
      const runHome = join(fixtureDirectory, "hermes-root");
      const profileHome = join(runHome, "profiles", `ebb-orchestrator-run-${runId}`);
      await mkdir(profileHome, { recursive: true, mode: 0o700 });
      const python = await resolvePython();
      const pythonIdentity = await objectIdentity(python, "file");
      const shimDirectory = join(fixtureDirectory, `shim-${runId}`);
      await mkdir(shimDirectory, { recursive: true });
      const shimPath = join(shimDirectory, windows ? "hermes.exe" : "hermes");
      await writeFile(shimPath, "synthetic Hermes shim identity; never executed\n");
      if (linux) await chmod(shimPath, 0o700);
      const shimIdentity = await objectIdentity(shimPath, "file");
      const profileIdentity = await objectIdentity(profileHome, "directory");
      const snapshotIdentity = await objectIdentity(snapshot.rootPath, "directory");
      const ticketData = { digest: sha256(originalProjection), size: originalProjection.byteLength };
      const owner = prepareRunProcessOwner(runId, profileHome, windows ? "windows-job" : "systemd-user-service", snapshot.cacheKey);
      const scope = toScopeIdentity(owner);
      const markerPath = join(fixtureDirectory, "payload.marker");
      const startGatePath = join(fixtureDirectory, "payload.start");
      const descendantPath = join(fixtureDirectory, "descendant.pid");
      const descendantReleasePath = join(fixtureDirectory, "descendant.release");
      const payload = pythonAcceptancePayload({
        snapshotRoot: snapshot.rootPath, markerPath, startGatePath, descendantPath, descendantReleasePath,
      });
      const ticket = makeTicket({
        runId, attempt: 1, python, pythonIdentity, shimPath, shimIdentity, profileHome, profileIdentity,
        snapshotRoot: acceptedSnapshot.rootPath, snapshotIdentity, cacheKey: acceptedSnapshot.cacheKey,
        manifestDigest: acceptedSnapshot.manifestDigest, projectionPath: projection.path,
        projectionDigest: ticketData.digest, projectionSize: ticketData.size,
        payload,
      });
      let handle: ProcessScopeHandle | undefined;
      let liveIdentity: ProcessScopeIdentity | undefined;
      let stopped: ProcessScopeObservation | undefined;
      let sharedPreflightLeases: Awaited<ReturnType<typeof acquireHermesSourceReferenceLock>>[] = [];
      let exclusiveGcLease: Awaited<ReturnType<typeof acquireHermesSourceReferenceLock>> | undefined;
      let exclusiveGcPending: Promise<Awaited<ReturnType<typeof acquireHermesSourceReferenceLock>>> | undefined;
      const exclusiveGcAbort = new AbortController();
      let exclusiveGcResolved = false;
      try {
          handle = await supervisor.launch(scope, {
            executable: python,
            args: ["-I", "-B", "-S", "-c", payload],
            cwd: fixtureDirectory,
            environment: hermesEnvironment(runHome, profileHome),
            attempt: 1,
            hermesLaunchTicket: ticket,
            timeoutMs: 120_000,
          }, async (identity) => { liveIdentity = identity; });
        } catch (error) {
          const observed = await supervisor.inspect(liveIdentity ?? scope);
          let refusalStop = observed;
          if (observed.state === "LIVE") {
            const stoppedBySupervisor = await supervisor.stop(observed.identity).catch(() => ({ state: "UNKNOWN" as const, reason: "LAUNCH_FAILURE_STOP_FAILED" }));
            refusalStop = stoppedBySupervisor.state === "STOPPED"
              ? stoppedBySupervisor
              : await supervisor.waitForStopped(observed.identity, 30_000);
          }
          if (refusalStop.state !== "STOPPED") {
            cleanupBlocked = true;
            throw new Error("SOURCE_ACCEPTANCE_LAUNCH_FAILURE_STOP_UNPROVEN; fixture retained", { cause: error });
          }
          throw error;
        }
        try {
        if (!liveIdentity) throw new Error("SOURCE_ACCEPTANCE_LIVE_IDENTITY_MISSING");
        await waitForFile(descendantPath, 15_000);
        await writeFile(fixture.originalModulePath, "VALUE = 'mutable-checkout-v2'\n");
        await writeFile(startGatePath, "go");
        await waitForFile(markerPath, 15_000);
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
        expect(marker.importedValue).toBe(SOURCE_MARKER);
        expect(marker.adjacentResourceValue).toBe(SOURCE_RESOURCE);
        expect(marker.snapshotHasPycache).toBe(false);
        expect(marker.snapshotWriteBlocked).toBe(true);
        expect(marker.snapshotDeleteBlocked).toBe(true);

        if (windows) {
          const sourceFile = join(snapshot.rootPath, "marker_module.py");
          const replacementPath = join(snapshot.rootPath, "marker_module.replacement");
          await expect(rm(sourceFile)).rejects.toThrow();
          await expect(writeFile(sourceFile, "VALUE = 'replace-attempt'\n")).rejects.toThrow();
          await writeFile(replacementPath, "VALUE = 'rename-replacement'\n");
          await expect(rename(replacementPath, sourceFile)).rejects.toThrow();
        } else {
          const simultaneousShared = await Promise.allSettled([
            acquireHermesSourceReferenceLock({ cacheRoot, mode: "shared" }),
            acquireHermesSourceReferenceLock({ cacheRoot, mode: "shared" }),
          ]);
          sharedPreflightLeases = simultaneousShared.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          const sharedFailure = simultaneousShared.find((result) => result.status === "rejected");
          if (sharedFailure?.status === "rejected") throw sharedFailure.reason;
          for (const lease of sharedPreflightLeases) lease.assertHeld();
          await Promise.all(sharedPreflightLeases.map((lease) => lease.release()));
          sharedPreflightLeases = [];
          exclusiveGcPending = acquireHermesSourceReferenceLock({ cacheRoot, mode: "exclusive", signal: exclusiveGcAbort.signal }).then((lease) => {
            exclusiveGcResolved = true;
            exclusiveGcLease = lease;
            return lease;
          });
          void exclusiveGcPending.catch(() => undefined);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
          expect(exclusiveGcResolved, "exclusive GC/reference lease must wait while the native run holds shared lease").toBe(false);
        }

        const live = await supervisor.inspect(liveIdentity);
        expect(live.state, "descendant must keep the exact native scope populated").toBe("LIVE");
        await writeFile(descendantReleasePath, "release");
        await handle.completion;
        stopped = await supervisor.waitForStopped(liveIdentity, 30_000);
        expect(stopped.state).toBe("STOPPED");
        if (linux && exclusiveGcPending) {
          exclusiveGcLease = await exclusiveGcPending;
          exclusiveGcLease.assertHeld();
          await exclusiveGcLease.release();
          exclusiveGcLease = undefined;
        }
        if (windows) {
          const sourceFile = join(snapshot.rootPath, "marker_module.py");
          const replacementPath = join(snapshot.rootPath, "marker_module.replacement");
          await chmod(sourceFile, 0o600);
          await writeFile(replacementPath, "VALUE = 'post-stop-mutation'\n");
          await rename(replacementPath, sourceFile);
          expect(await readFile(sourceFile, "utf8")).toContain("post-stop-mutation");
        }
      } catch (error) {
        primaryFailure = error;
      }
      try {
        await writeFile(descendantReleasePath, "release").catch(() => undefined);
        if (handle && liveIdentity) {
          const observed = await supervisor.waitForStopped(liveIdentity, 30_000).catch(() => ({ state: "UNKNOWN" as const, reason: "ACCEPTANCE_STOP_OBSERVATION_FAILED" }));
          if (observed.state !== "STOPPED") {
            const stoppedBySupervisor = await supervisor.stop(liveIdentity).catch(() => ({ state: "UNKNOWN" as const, reason: "ACCEPTANCE_STOP_FAILED" }));
            stopped = stoppedBySupervisor.state === "STOPPED" ? stoppedBySupervisor : await supervisor.waitForStopped(liveIdentity, 30_000);
          } else stopped = observed;
          if (stopped.state !== "STOPPED") {
            cleanupBlocked = true;
            cleanupFailure = new Error("SOURCE_ACCEPTANCE_SCOPE_STOP_UNPROVEN; fixture retained");
          } else {
            await handle.completion.catch(() => undefined);
          }
        }
        try {
          await Promise.all(sharedPreflightLeases.map((lease) => lease.release()));
        } catch (error) {
          cleanupBlocked = true;
          cleanupFailure ??= error;
        }
        if (linux && exclusiveGcPending) {
          if (stopped?.state !== "STOPPED") exclusiveGcAbort.abort();
          const lease = exclusiveGcLease ?? await exclusiveGcPending.catch(() => undefined);
          if (lease) {
            try { await lease.release(); } catch (error) { cleanupBlocked = true; cleanupFailure ??= error; }
          } else {
            await exclusiveGcPending.catch(() => undefined);
          }
        }
      } catch (error) {
        cleanupBlocked = true;
        cleanupFailure ??= error;
      }
    } finally {
      if (!cleanupBlocked) {
        try {
          await writeProjection(projection.path, originalProjection);
        } catch (error) {
          cleanupBlocked = true;
          cleanupFailure ??= error;
        }
      }
    }
    if (primaryFailure !== undefined && cleanupFailure !== undefined) {
      throw new AggregateError([primaryFailure, cleanupFailure], "SOURCE_ACCEPTANCE_AND_CLEANUP_FAILED", { cause: primaryFailure });
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }, 240_000);
});

async function launchAndAssertRefused(input: {
  fixtureDirectory: string;
  snapshot: Awaited<ReturnType<typeof materializeHermesSourceSnapshot>>;
  projectionPath: string;
  expectedProjection: Buffer;
  supervisor: ProcessScopeSupervisor;
  onUnprovenStop: () => void;
}): Promise<{ observation: ProcessScopeObservation; markerPath: string }> {
  const runId = randomUUID();
  const runHome = join(input.fixtureDirectory, `refusal-root-${runId}`);
  const profileHome = join(runHome, "profiles", `ebb-orchestrator-run-${runId}`);
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  const python = await resolvePython();
  const pythonIdentity = await objectIdentity(python, "file");
  const shimDirectory = join(input.fixtureDirectory, `shim-${runId}`);
  await mkdir(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, windows ? "hermes.exe" : "hermes");
  await writeFile(shimPath, "synthetic shim\n");
  if (linux) await chmod(shimPath, 0o700);
  const shimIdentity = await objectIdentity(shimPath, "file");
  const profileIdentity = await objectIdentity(profileHome, "directory");
  const snapshotIdentity = await objectIdentity(input.snapshot.rootPath, "directory");
  const markerPath = join(input.fixtureDirectory, `${runId}.must-not-exist`);
  const owner = prepareRunProcessOwner(runId, profileHome, windows ? "windows-job" : "systemd-user-service", input.snapshot.cacheKey);
  const payload = `from pathlib import Path; Path(${JSON.stringify(markerPath)}).write_text('DISPATCHED', encoding='utf-8')`;
  const ticketProjection = { digest: sha256(input.expectedProjection), size: input.expectedProjection.byteLength };
  const ticket = makeTicket({
    runId, attempt: 1, python, pythonIdentity, shimPath, shimIdentity, profileHome, profileIdentity,
    snapshotRoot: input.snapshot.rootPath, snapshotIdentity, cacheKey: input.snapshot.cacheKey,
    manifestDigest: input.snapshot.manifestDigest, projectionPath: input.projectionPath,
    projectionDigest: ticketProjection.digest, projectionSize: ticketProjection.size,
    payload,
  });
  let liveIdentity: ProcessScopeIdentity | undefined;
  let handle: ProcessScopeHandle | undefined;
  let observation: ProcessScopeObservation = { state: "UNKNOWN", reason: "REFUSAL_NOT_OBSERVED" };
  let nativeRefusalEvidence: string;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let result: { observation: ProcessScopeObservation; markerPath: string } | undefined;
  try {
    try {
      handle = await input.supervisor.launch(toScopeIdentity(owner), {
        executable: python, args: ["-I", "-B", "-S", "-c", payload], cwd: input.fixtureDirectory,
        environment: hermesEnvironment(runHome, profileHome), attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
      }, async (identity) => { liveIdentity = identity; });
      const completed = await handle.completion;
      nativeRefusalEvidence = `${completed.stderr}\n${completed.stdout}`;
      expect(completed.exitCode, "native verifier must reject the projection before Python dispatch").not.toBe(0);
    } catch (error) {
      // Windows can refuse before publishing a live identity; Linux may report through cgroup exit.
      nativeRefusalEvidence = collectNativeHelperEvidence(error);
    }
    if (liveIdentity) observation = await input.supervisor.waitForStopped(liveIdentity, 30_000);
    else observation = await input.supervisor.inspect(toScopeIdentity(owner));
    if (observation.state !== "STOPPED") {
      const stopped = await input.supervisor.stop(liveIdentity ?? toScopeIdentity(owner)).catch(() => ({ state: "UNKNOWN" as const, reason: "REFUSAL_CLEANUP_UNKNOWN" }));
      observation = stopped.state === "STOPPED" ? stopped : await input.supervisor.waitForStopped(liveIdentity ?? toScopeIdentity(owner), 30_000);
    }
    if (observation.state !== "STOPPED") {
      input.onUnprovenStop();
      throw new Error("SOURCE_ACCEPTANCE_REFUSAL_SCOPE_STOP_UNPROVEN; fixture retained");
    }
    if (windows) {
      expect(nativeRefusalEvidence).toContain("WINDOWS_HELPER_NATIVE_UNKNOWN:HERMES_TICKET_OBJECT_MISMATCH");
    } else {
      expect(nativeRefusalEvidence).toMatch(/HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_(?:PROJECTION_UNAVAILABLE|SNAPSHOT_CONTENT_MISMATCH)/u);
    }
    result = { observation, markerPath };
  } catch (error) {
    primaryFailure = error;
  }
  try {
    if (liveIdentity && observation.state !== "STOPPED") {
      const stopped = await input.supervisor.waitForStopped(liveIdentity, 30_000);
      if (stopped.state !== "STOPPED") {
        input.onUnprovenStop();
        cleanupFailure = new Error("SOURCE_ACCEPTANCE_REFUSAL_SCOPE_STOP_UNPROVEN; fixture retained");
      }
    }
  } catch (error) {
    input.onUnprovenStop();
    cleanupFailure ??= error;
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], "SOURCE_ACCEPTANCE_REFUSAL_AND_CLEANUP_FAILED", { cause: primaryFailure });
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!result) throw new Error("SOURCE_ACCEPTANCE_REFUSAL_RESULT_UNAVAILABLE");
  return result;
}

function makeTicket(input: {
  runId: string; attempt: number; python: string; pythonIdentity: HermesLaunchObjectIdentity;
  shimPath: string; shimIdentity: HermesLaunchObjectIdentity; profileHome: string;
  profileIdentity: HermesLaunchObjectIdentity; snapshotRoot: string; snapshotIdentity: HermesLaunchObjectIdentity;
  cacheKey: string; manifestDigest: string; projectionPath: string; projectionDigest: string; projectionSize: number;
  payload: string;
}): HermesLaunchTicket {
  const platform = windows ? "win32" : "linux";
  const sourceRoot = input.snapshotRoot;
  const profileRoot = dirname(dirname(input.profileHome));
  return createHermesLaunchTicket({
    runId: input.runId, attempt: input.attempt, platform,
    hermesExecutablePath: input.shimPath, hermesExecutableIdentity: input.shimIdentity,
    executablePath: input.python, executableIdentity: input.pythonIdentity,
    executableArgsPrefix: ["-I", "-B", "-S", "-c", input.payload],
    profileHome: input.profileHome, profileHomeIdentity: input.profileIdentity,
    hermesSourceSnapshotKey: input.cacheKey,
    hermesSourceSnapshotRoot: sourceRoot, hermesSourceSnapshotRootIdentity: input.snapshotIdentity,
    hermesSourceManifestDigest: input.manifestDigest,
    hermesSourceProjectionPath: input.projectionPath,
    hermesSourceProjectionSha256: input.projectionDigest, hermesSourceProjectionSize: input.projectionSize,
    environment: { HERMES_HOME: input.profileHome, HOME: profileRoot, HERMES_CONFIG: join(input.profileHome, "config.yaml") },
  });
}

function pythonAcceptancePayload(input: {
  snapshotRoot: string; markerPath: string; startGatePath: string; descendantPath: string; descendantReleasePath: string;
}): string {
  return [
    "import os, pathlib, subprocess, sys, time, json",
    `root = pathlib.Path(${JSON.stringify(input.snapshotRoot)})`,
    `sys.path.insert(0, str(root))`,
    `desc = subprocess.Popen([sys.executable, '-I', '-B', '-S', '-c', ${JSON.stringify("import pathlib,sys,time,os\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8')\npathlib.Path(sys.argv[2]).write_text('live', encoding='utf-8')\nwhile not pathlib.Path(sys.argv[3]).exists(): time.sleep(0.05)")}, ${JSON.stringify(input.descendantPath)}, ${JSON.stringify(input.descendantPath + ".live")}, ${JSON.stringify(input.descendantReleasePath)}], close_fds=True)`,
    `pathlib.Path(${JSON.stringify(input.descendantPath)} + '.spawned').write_text(str(desc.pid), encoding='utf-8')`,
    `gate = pathlib.Path(${JSON.stringify(input.startGatePath)})`,
    "deadline = time.monotonic() + 30",
    "while not gate.exists() and time.monotonic() < deadline: time.sleep(0.05)",
    "if not gate.exists(): raise SystemExit(31)",
    "import marker_module",
    "adjacent_resource = pathlib.Path(marker_module.__file__).with_name('adjacent-resource.txt')",
    "adjacent_resource_value = adjacent_resource.read_text(encoding='utf-8').strip()",
    "source = root / 'marker_module.py'",
    "snapshot_has_pycache = any(path.name == '__pycache__' for path in root.rglob('__pycache__'))",
    "write_blocked = delete_blocked = False",
    "try: source.write_text('VALUE = \\\"mutated\\\"', encoding='utf-8')",
    "except OSError: write_blocked = True",
    "try: source.unlink()",
    "except OSError: delete_blocked = True",
    `pathlib.Path(${JSON.stringify(input.markerPath)}).write_text(json.dumps({'importedValue': marker_module.VALUE, 'adjacentResourceValue': adjacent_resource_value, 'snapshotHasPycache': snapshot_has_pycache, 'snapshotWriteBlocked': write_blocked, 'snapshotDeleteBlocked': delete_blocked}), encoding='utf-8')`,
    "sys.exit(0)",
  ].join("\n");
}

function hermesEnvironment(_runHome: string, profileHome: string): Record<string, string> {
  return {
    HERMES_HOME: profileHome,
    HOME: dirname(dirname(profileHome)),
    HERMES_CONFIG: join(profileHome, "config.yaml"),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  };
}

async function snapshotContainsPycache(rootPath: string): Promise<boolean> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__pycache__") return true;
    if (entry.isDirectory() && await snapshotContainsPycache(join(rootPath, entry.name))) return true;
  }
  return false;
}

async function objectIdentity(pathname: string, kind: "file" | "directory"): Promise<HermesLaunchObjectIdentity> {
  if (linux) {
    const details = await stat(pathname, { bigint: true });
    if (kind === "file" ? !details.isFile() : !details.isDirectory()) throw new Error("SOURCE_ACCEPTANCE_OBJECT_TYPE_INVALID");
    return { platform: "linux", device: String(details.dev), inode: String(details.ino) };
  }
  const invocation = await createWindowsNativeHelperInvocation(profileHelperPath, "hermesProfilePath", ["verify-safe-path", kind, pathname]);
  let result: ProcessResult;
  try {
    result = await new ProcessExecutor().exec(invocation.file, [...invocation.args], {
      cwd: tmpdir(), env: { ...invocation.env }, timeout: 10_000, maxBuffer: 16 * 1024,
    });
  } catch (error) {
    throw new Error(`SOURCE_ACCEPTANCE_NATIVE_IDENTITY_UNAVAILABLE:${collectNativeHelperEvidence(error)}`, { cause: error });
  }
  if (result.exitCode !== 0 || result.stderr !== "") throw new Error("SOURCE_ACCEPTANCE_NATIVE_IDENTITY_UNAVAILABLE");
  const parsed = JSON.parse(result.stdout.trim()) as { volumeSerial?: string; fileId?: string; kind?: string; status?: string };
  if (parsed.status !== "SAFE_PATH" || parsed.kind !== kind || !parsed.volumeSerial || !parsed.fileId) {
    throw new Error("SOURCE_ACCEPTANCE_NATIVE_IDENTITY_INVALID");
  }
  return { platform: "win32", volumeSerial: parsed.volumeSerial, fileId: parsed.fileId };
}

function collectNativeHelperEvidence(error: unknown): string {
  const evidence: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (typeof current === "object") {
      const candidate = current as { message?: unknown; stderr?: unknown; cause?: unknown };
      if (typeof candidate.stderr === "string") {
        const gateFailure = candidate.stderr.match(/NATIVE_HELPER_GATE_FAIL:[A-Za-z0-9_-]+:[A-Za-z0-9_]+/u)?.[0];
        if (gateFailure) evidence.push(gateFailure);
      }
      current = candidate.cause;
    } else break;
  }
  if (evidence.length > 0) return [...new Set(evidence)].join("|");
  if (error instanceof Error) {
    const exitCode = error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number"
      ? `:EXIT_${error.exitCode}`
      : "";
    return `${error.name || "Error"}${exitCode}:NO_SAFE_GATE_DIAGNOSTIC`;
  }
  return "NATIVE_HELPER_FAILURE_UNKNOWN";
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  return "UNKNOWN";
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function sameObjectIdentity(left: HermesLaunchObjectIdentity, right: HermesLaunchObjectIdentity): boolean {
  if (left.platform !== right.platform) return false;
  return left.platform === "win32" && right.platform === "win32"
    ? left.volumeSerial === right.volumeSerial && left.fileId === right.fileId
    : left.platform === "linux" && right.platform === "linux" && left.device === right.device && left.inode === right.inode;
}

async function makeFixtureRemovable(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("SOURCE_ACCEPTANCE_CLEANUP_ROOT_UNSAFE");
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory)) {
    const entryPath = join(directory, entry);
    const entryDetails = await lstat(entryPath);
    if (entryDetails.isSymbolicLink()) throw new Error("SOURCE_ACCEPTANCE_CLEANUP_REPARSE_ENTRY_UNSAFE");
    if (entryDetails.isDirectory()) await makeFixtureRemovable(entryPath);
    else if (entryDetails.isFile()) await chmod(entryPath, 0o600);
    else throw new Error("SOURCE_ACCEPTANCE_CLEANUP_ENTRY_TYPE_UNSUPPORTED");
  }
}

async function replaceProjection(pathname: string, original: Buffer, variant: "changed" | "missing" | "extra" | "hash" | "malformed"): Promise<void> {
  if (variant === "missing") { await rm(pathname); return; }
  const changed = Buffer.from(original);
  if (variant === "changed") changed.writeUInt16LE(2, 4);
  else if (variant === "extra") return writeProjection(pathname, Buffer.concat([changed, Buffer.from([0]) ]));
  else if (variant === "hash") changed[changed.length - 1] = changed[changed.length - 1]! ^ 0xff;
  else if (variant === "malformed") return writeProjection(pathname, Buffer.from("EHSP\x01", "binary"));
  await writeProjection(pathname, changed);
}

async function writeProjection(pathname: string, bytes: Buffer): Promise<void> {
  await chmod(pathname, 0o600).catch(() => undefined);
  await writeFile(pathname, bytes);
  await chmod(pathname, 0o400).catch(() => undefined);
}

async function resolveGit(): Promise<string> {
  const candidate = windows ? "git.exe" : "git";
  const result = await new ProcessExecutor().exec(candidate, ["--version"], {
    cwd: repositoryRoot, env: processEnvironment(), timeout: 5_000, maxBuffer: 1024,
  });
  if (result.exitCode !== 0) throw new Error("SOURCE_ACCEPTANCE_GIT_UNAVAILABLE");
  return candidate;
}

async function resolvePython(): Promise<string> {
  const candidates = windows ? ["python", "py"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const args = candidate === "py" ? ["-3", "-c", "import sys;print(sys.executable)"] : ["-c", "import sys;print(sys.executable)"];
      const result = await new ProcessExecutor().exec(candidate, args, { cwd: tmpdir(), env: processEnvironment(), timeout: 5_000, maxBuffer: 4096 });
      if (result.exitCode === 0) {
        const executable = result.stdout.trim();
        if (executable && (await stat(executable).catch(() => undefined))?.isFile()) return executable;
      }
    } catch { /* Try the next hosted-runner interpreter name. */ }
  }
  throw new Error("SOURCE_ACCEPTANCE_PYTHON_UNAVAILABLE");
}

function toScopeIdentity(owner: ReturnType<typeof prepareRunProcessOwner>): ProcessScopeIdentity {
  return {
    runId: owner.runId, containmentKind: owner.containmentKind, containmentId: owner.containmentId,
    launchNonce: owner.launchNonce, systemdInvocationId: null, systemdControlGroup: null,
    supervisorPid: null, supervisorStartIdentity: null, pid: null, platform: null,
    processStartIdentity: null, executableIdentity: null, state: "PREPARED",
  };
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function markerExists(pathname: string): Promise<boolean> { return access(pathname).then(() => true, () => false); }

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
