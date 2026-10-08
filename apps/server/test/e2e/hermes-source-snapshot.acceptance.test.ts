import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createWindowsPrivateFixtureDirectory } from "../../scripts/windows-fixture-acl.mjs";
import { createHermesLaunchTicket, type HermesLaunchObjectIdentity, type HermesLaunchTicket, type HermesLaunchTicketInput } from "../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { ensureHermesSourceSnapshotNativeProjection, materializeHermesSourceSnapshot } from "../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { acquireHermesSourceReferenceLock } from "../../src/modules/runtime/hermes/hermes-source-reference-lock.js";
import { prepareRunProcessOwner } from "../../src/modules/runtime/run-process-owner.js";
import { ProcessExecutor, type ProcessResult } from "../../src/platform/process/process-executor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../src/platform/process/process-inspector.js";
import type { ProcessScopeHandle, ProcessScopeSupervisor } from "../../src/platform/process/run-scope-supervisor.js";
import { createWindowsNativeHelperInvocation } from "../../src/platform/process/windows-native-helper-launcher.js";
import { runVerifiedNativeHelper } from "../../src/platform/process/native-helper-launcher.js";
import { verifyHermesProfileHomePathChain } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";
import { withHermesSourceSnapshotFailureObserver, type HermesSourceSnapshotDiagnosticPhase } from "../../src/modules/runtime/hermes/hermes-source-snapshot-diagnostics.js";
import { createPinnedGitFixture, waitForFile } from "../helpers/hermes-source-snapshot-acceptance-fixture.js";
import { safeRestartChildFailureCode } from "../helpers/restart-child-diagnostics.js";
import { safeHermesLaunchFailureAssertionContext } from "../helpers/safe-hermes-profile-chain-message.js";

const enabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";
const windows = process.platform === "win32";
const linux = process.platform === "linux";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const helperDirectory = resolve(repositoryRoot, "apps/server/dist/native/hermes-profile-path");
const windowsSupervisorPath = resolve(repositoryRoot, "apps/server/dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
const linuxLauncherPath = resolve(repositoryRoot, "apps/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher");
const profileHelperPath = join(helperDirectory, windows ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path");
type HermesLaunchEnvironment = HermesLaunchTicketInput["environment"] & Record<string, string>;
const PINNED_VERSION = "v0.21.5+9117.g08165d5";
const SOURCE_MARKER = "snapshot-pinned-v1";
const SOURCE_RESOURCE = "snapshot-resource-pinned-v1";
const SAFE_PROCESS_SCOPE_OBSERVATION_REASONS = new Set([
  "CGROUP_READ_UNAVAILABLE",
  "REFUSAL_CLEANUP_UNKNOWN",
  "SYSTEMD_CGROUP_UNIT_STATE_MISMATCH",
  "SYSTEMD_CONTAINMENT_PROPERTY_MISMATCH",
  "SYSTEMD_CONTROL_GROUP_READBACK_MISMATCH",
  "SYSTEMD_EMPTY_ACTIVE_UNIT",
  "SYSTEMD_IDENTITY_MISMATCH",
  "SYSTEMD_INSPECTION_UNAVAILABLE",
  "SYSTEMD_MANAGER_QUERY_UNAVAILABLE",
  "SYSTEMD_CGROUP_STATFS_UNAVAILABLE",
  "SYSTEMD_CGROUP_V2_REQUIRED",
  "SYSTEMD_MANAGER_ENVIRONMENT_INVALID",
  "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE",
  "SYSTEMD_MANAGER_STATE_INITIALIZING",
  "SYSTEMD_MANAGER_STATE_STARTING",
  "SYSTEMD_MANAGER_STATE_MAINTENANCE",
  "SYSTEMD_MANAGER_STATE_STOPPING",
  "SYSTEMD_MANAGER_STATE_OFFLINE",
  "SYSTEMD_MANAGER_STATE_UNKNOWN",
  "SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE",
  "SYSTEMD_PREREQUISITE_CHECK_UNAVAILABLE",
  "SYSTEMD_SCOPE_READBACK_UNAVAILABLE",
  "SYSTEMD_STOP_FAILED",
  "SYSTEMD_STOP_IDENTITY_MISMATCH",
  "SYSTEMD_STOP_TIMEOUT",
  "SYSTEMD_UNIT_ABSENCE_UNPROVEN",
  "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE",
  "SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED",
  "WINDOWS_JOB_IDENTITY_MISMATCH",
  "WINDOWS_JOB_IDENTITY_UNPROVEN",
  "WINDOWS_JOB_INSPECTION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_PROCESS_TIMEOUT",
  "WINDOWS_JOB_INSPECTION_OUTPUT_LIMIT",
  "WINDOWS_JOB_INSPECTION_PROCESS_ABORTED",
  "WINDOWS_JOB_INSPECTION_PROCESS_EXIT_NONZERO",
  "WINDOWS_JOB_INSPECTION_PROCESS_SPAWN_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_ARGUMENT_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_PATH_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_FILE_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_MISMATCH",
  "WINDOWS_JOB_INSPECTION_HELPER_PROCESS_START_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_NATIVE_LAUNCH_FAILED",
  "WINDOWS_JOB_INSPECTION_NATIVE_REFUSAL",
  "WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED",
  "WINDOWS_JOB_STOP_FAILED",
  "WINDOWS_JOB_STOP_TIMEOUT",
]);

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
    if (cleanupBlocked) throw new Error("SOURCE_ACCEPTANCE_FIXTURE_RETAINED_STOP_NOT_PROVEN");
    if (!fixtureDirectoryIdentity) throw new Error("SOURCE_ACCEPTANCE_FIXTURE_IDENTITY_UNPROVEN_RETAINED");
    const currentIdentity = await objectIdentity(fixtureDirectory, "directory");
    if (!sameObjectIdentity(currentIdentity, fixtureDirectoryIdentity)) {
      throw new Error("SOURCE_ACCEPTANCE_FIXTURE_IDENTITY_CHANGED_RETAINED");
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
    if (windows) {
      const systemPowerShellPath = await resolveVerifiedSystemPowerShellPath();
      const volumeRoot = win32.parse(systemPowerShellPath).root;
      if (!volumeRoot || !/^[A-Za-z]:\\$/u.test(volumeRoot)) throw new Error("SOURCE_ACCEPTANCE_FIXTURE_VOLUME_ROOT_UNAVAILABLE");
      const candidate = win32.join(volumeRoot, `ebb-hermes-source-acceptance-${randomUUID()}`);
      fixtureDirectory = candidate;
      createWindowsPrivateFixtureDirectory(candidate, {
        serverDirectory: resolve(repositoryRoot, "apps/server"), systemPowerShellPath,
      });
    } else {
      fixtureDirectory = await mkdtemp(join(tmpdir(), "ebb-hermes-source-acceptance-"));
    }
    fixtureDirectoryIdentity = await objectIdentity(fixtureDirectory, "directory");
    const fixture = await createPinnedGitFixture(fixtureDirectory);
    const cacheRoot = join(fixtureDirectory, "source-cache");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const cacheRootIdentity = await objectIdentity(cacheRoot, "directory");
    expect(cacheRootIdentity.platform).toBe(windows ? "win32" : "linux");
      let snapshotFailurePhase: HermesSourceSnapshotDiagnosticPhase | undefined;
      let snapshot: Awaited<ReturnType<typeof materializeHermesSourceSnapshot>>;
      const gitExecutable = await resolveGit();
      try {
        snapshot = await withHermesSourceSnapshotFailureObserver(
          (phase) => { snapshotFailurePhase = phase; },
          () => materializeHermesSourceSnapshot({
            gitExecutable, sourceRoot: fixture.sourceRoot, cacheRoot,
            hermesVersion: PINNED_VERSION, commit: fixture.commit, tree: fixture.tree,
          }),
        );
      } catch {
        throw new Error(`SOURCE_ACCEPTANCE_SNAPSHOT_FAILED:${snapshotFailurePhase ?? "UNKNOWN"}`);
      }
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
          variant,
          expectedProjection: variant === "missing" || variant === "malformed"
            ? originalProjection
            : await readFile(projection.path),
          expectedNativeFailureCode: variant === "hash"
            ? "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH:CONTENT_MISMATCH"
            : "LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE",
          expectedLinuxFailureCode: variant === "missing"
            ? "HERMES_SOURCE_PROJECTION_UNAVAILABLE"
            : "HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH",
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
      const profileHomeDirectory = join(profileHome, "home");
      const profileConfig = join(profileHome, "config.yaml");
      await mkdir(profileHomeDirectory, { recursive: true, mode: 0o700 });
      await writeFile(profileConfig, "fixture Hermes profile; provider-free\n", { mode: 0o600 });
      const python = await resolvePython();
      const pythonIdentity = await objectIdentity(python, "file", windows ? dirname(python) : undefined);
      const shimDirectory = join(fixtureDirectory, `shim-${runId}`);
      await mkdir(shimDirectory, { recursive: true });
      const shimPath = join(shimDirectory, windows ? "hermes.exe" : "hermes");
      await writeFile(shimPath, "synthetic Hermes shim identity; never executed\n");
      if (linux) await chmod(shimPath, 0o700);
      const shimIdentity = await objectIdentity(shimPath, "file");
      const profileIdentity = await objectIdentity(profileHome, "directory");
      const profileHomeTargetIdentities = windows ? {
        home: await objectIdentity(profileHomeDirectory, "directory"),
        config: await objectIdentity(profileConfig, "file"),
      } : undefined;
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
      const args = ["-I", "-B", "-S", "-c", payload];
      const environment = hermesEnvironment(profileHome);
      const ticket = makeTicket({
        runId, attempt: 1, python, pythonIdentity, shimPath, shimIdentity, profileHome, profileIdentity,
        ...(profileHomeTargetIdentities ? { profileHomeTargetIdentities } : {}),
        ...(windows ? { profileHomePathChain: await verifyHermesProfileHomePathChain(profileHome, runHome) } : {}),
        snapshotRoot: acceptedSnapshot.rootPath, snapshotIdentity, cacheKey: acceptedSnapshot.cacheKey,
        manifestDigest: acceptedSnapshot.manifestDigest, projectionPath: projection.path,
        projectionDigest: ticketData.digest, projectionSize: ticketData.size,
        args, environment,
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
            args,
            cwd: fixtureDirectory,
            environment,
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
  variant: "changed" | "missing" | "extra" | "hash" | "malformed";
  expectedProjection: Buffer;
  expectedNativeFailureCode: "LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE" |
    "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH:CONTENT_MISMATCH";
  expectedLinuxFailureCode: "HERMES_SOURCE_PROJECTION_UNAVAILABLE" | "HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH";
  supervisor: ProcessScopeSupervisor;
  onUnprovenStop: () => void;
}): Promise<{ observation: ProcessScopeObservation; markerPath: string }> {
  const runId = randomUUID();
  const runHome = join(input.fixtureDirectory, `refusal-root-${runId}`);
  const profileHome = join(runHome, "profiles", `ebb-orchestrator-run-${runId}`);
  await mkdir(profileHome, { recursive: true, mode: 0o700 });
  const profileHomeDirectory = join(profileHome, "home");
  const profileConfig = join(profileHome, "config.yaml");
  await mkdir(profileHomeDirectory, { recursive: true, mode: 0o700 });
  await writeFile(profileConfig, "fixture Hermes profile; provider-free\n", { mode: 0o600 });
  const python = await resolvePython();
  const pythonIdentity = await objectIdentity(python, "file", windows ? dirname(python) : undefined);
  const shimDirectory = join(input.fixtureDirectory, `shim-${runId}`);
  await mkdir(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, windows ? "hermes.exe" : "hermes");
  await writeFile(shimPath, "synthetic shim\n");
  if (linux) await chmod(shimPath, 0o700);
  const shimIdentity = await objectIdentity(shimPath, "file");
  const profileIdentity = await objectIdentity(profileHome, "directory");
  const profileHomeTargetIdentities = windows ? {
    home: await objectIdentity(profileHomeDirectory, "directory"),
    config: await objectIdentity(profileConfig, "file"),
  } : undefined;
  const snapshotIdentity = await objectIdentity(input.snapshot.rootPath, "directory");
  const markerPath = join(input.fixtureDirectory, `${runId}.must-not-exist`);
  const owner = prepareRunProcessOwner(runId, profileHome, windows ? "windows-job" : "systemd-user-service", input.snapshot.cacheKey);
  const payload = `from pathlib import Path; Path(${JSON.stringify(markerPath)}).write_text('DISPATCHED', encoding='utf-8')`;
  const args = ["-I", "-B", "-S", "-c", payload];
  const environment = hermesEnvironment(profileHome);
  const ticketProjection = { digest: sha256(input.expectedProjection), size: input.expectedProjection.byteLength };
  const ticket = makeTicket({
    runId, attempt: 1, python, pythonIdentity, shimPath, shimIdentity, profileHome, profileIdentity,
    ...(profileHomeTargetIdentities ? { profileHomeTargetIdentities } : {}),
    ...(windows ? { profileHomePathChain: await verifyHermesProfileHomePathChain(profileHome, runHome) } : {}),
    snapshotRoot: input.snapshot.rootPath, snapshotIdentity, cacheKey: input.snapshot.cacheKey,
    manifestDigest: input.snapshot.manifestDigest, projectionPath: input.projectionPath,
    projectionDigest: ticketProjection.digest, projectionSize: ticketProjection.size,
    args, environment,
  });
  let liveIdentity: ProcessScopeIdentity | undefined;
  let handle: ProcessScopeHandle | undefined;
  let observation: ProcessScopeObservation = { state: "UNKNOWN", reason: "REFUSAL_NOT_OBSERVED" };
  let nativeRefusalEvidence: string;
  let launchFailure: unknown;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let result: { observation: ProcessScopeObservation; markerPath: string } | undefined;
  let refusalOutput: { exitCode: number; stderr: string; stdout: string } | undefined;
  try {
    try {
      handle = await input.supervisor.launch(toScopeIdentity(owner), {
        executable: python, args, cwd: input.fixtureDirectory,
        environment, attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
      }, async (identity) => { liveIdentity = identity; });
      const completed = await handle.completion;
      refusalOutput = completed;
      nativeRefusalEvidence = linux
        ? safeLinuxRefusalEvidence(completed.stderr, completed.stdout) ?? "UNEXPECTED_NATIVE_REFUSAL_OUTPUT"
        : safeWindowsRefusalEvidence(completed.stderr, completed.stdout) ?? "UNEXPECTED_NATIVE_REFUSAL_OUTPUT";
      expect(completed.exitCode, "native verifier must reject the projection before Python dispatch").not.toBe(0);
    } catch (error) {
      // Windows can refuse before publishing a live identity; Linux may report through cgroup exit.
      launchFailure = error;
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
      throw refusalScopeStopUnprovenError(launchFailure, observation, liveIdentity);
    }
    if (windows) {
      expect(nativeRefusalEvidence, `${input.variant} EHSP refusal evidence`).toBe(
        `WINDOWS_HELPER_NATIVE_UNKNOWN:${input.expectedNativeFailureCode}`,
      );
    } else {
      expect(nativeRefusalEvidence, `${input.variant} EHSP refusal evidence; ${safeNativeRefusalOutputSummary(refusalOutput)}`).toBe(
        `HERMES_LINUX_LAUNCH_REFUSED:${input.expectedLinuxFailureCode}`,
      );
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
        cleanupFailure = refusalScopeStopUnprovenError(launchFailure, stopped, liveIdentity);
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

function refusalScopeStopUnprovenError(
  launchFailure: unknown,
  observation: ProcessScopeObservation,
  liveIdentity: ProcessScopeIdentity | undefined,
): Error {
  const failureCode = safeRestartChildFailureCode(launchFailure) ?? "NONE";
  const reason = observation.state === "UNKNOWN" && SAFE_PROCESS_SCOPE_OBSERVATION_REASONS.has(observation.reason)
    ? observation.reason
    : "NONE";
  return new Error(
    `SOURCE_ACCEPTANCE_REFUSAL_SCOPE_STOP_UNPROVEN; fixture retained; launchFailure=${failureCode}; ` +
    `observation=${observation.state}; reason=${reason}; liveIdentityPersisted=${liveIdentity ? "yes" : "no"}`,
  );
}

describe("process scope refusal diagnostics", () => {
  for (const reason of [
    "SYSTEMD_CGROUP_STATFS_UNAVAILABLE",
    "SYSTEMD_CGROUP_V2_REQUIRED",
    "SYSTEMD_MANAGER_ENVIRONMENT_INVALID",
    "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE",
    "SYSTEMD_MANAGER_STATE_INITIALIZING",
    "SYSTEMD_MANAGER_STATE_STARTING",
    "SYSTEMD_MANAGER_STATE_MAINTENANCE",
    "SYSTEMD_MANAGER_STATE_STOPPING",
    "SYSTEMD_MANAGER_STATE_OFFLINE",
    "SYSTEMD_MANAGER_STATE_UNKNOWN",
    "SYSTEMD_PREREQUISITE_CHECK_UNAVAILABLE",
    "SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED",
    "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE",
    "SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE",
    "SYSTEMD_SCOPE_READBACK_UNAVAILABLE",
  ]) {
    it(`preserves the fixed safe reason ${reason}`, () => {
      const diagnostic = refusalScopeStopUnprovenError(undefined, { state: "UNKNOWN", reason }, undefined);
      expect(diagnostic.message).toContain(`reason=${reason}`);
    });
  }

  it("hides an unrecognized observation reason", () => {
    const diagnostic = refusalScopeStopUnprovenError(undefined, {
      state: "UNKNOWN", reason: "arbitrary process output",
    }, undefined);
    expect(diagnostic.message).toContain("reason=NONE");
  });
});

function makeTicket(input: {
  runId: string; attempt: number; python: string; pythonIdentity: HermesLaunchObjectIdentity;
  shimPath: string; shimIdentity: HermesLaunchObjectIdentity; profileHome: string;
  profileIdentity: HermesLaunchObjectIdentity;
  profileHomeTargetIdentities?: NonNullable<HermesLaunchTicketInput["profileHomeTargetIdentities"]>;
  profileHomePathChain?: HermesLaunchTicketInput["profileHomePathChain"];
  snapshotRoot: string; snapshotIdentity: HermesLaunchObjectIdentity;
  cacheKey: string; manifestDigest: string; projectionPath: string; projectionDigest: string; projectionSize: number;
  args: string[];
  environment: HermesLaunchEnvironment;
}): HermesLaunchTicket {
  const platform = windows ? "win32" : "linux";
  const sourceRoot = input.snapshotRoot;
  return createHermesLaunchTicket({
    runId: input.runId, attempt: input.attempt, platform,
    hermesExecutablePath: input.shimPath, hermesExecutableIdentity: input.shimIdentity,
    executablePath: input.python, executableIdentity: input.pythonIdentity,
    executableArgsPrefix: input.args,
    profileHome: input.profileHome, profileHomeIdentity: input.profileIdentity,
    ...(input.profileHomeTargetIdentities ? { profileHomeTargetIdentities: input.profileHomeTargetIdentities } : {}),
    ...(input.profileHomePathChain ? { profileHomePathChain: input.profileHomePathChain } : {}),
    hermesSourceSnapshotKey: input.cacheKey,
    hermesSourceSnapshotRoot: sourceRoot, hermesSourceSnapshotRootIdentity: input.snapshotIdentity,
    hermesSourceManifestDigest: input.manifestDigest,
    hermesSourceProjectionPath: input.projectionPath,
    hermesSourceProjectionSha256: input.projectionDigest, hermesSourceProjectionSize: input.projectionSize,
    environment: input.environment,
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

function hermesEnvironment(profileHome: string): HermesLaunchEnvironment {
  return {
    HERMES_HOME: profileHome,
    HOME: join(profileHome, "home"),
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

async function objectIdentity(pathname: string, kind: "file" | "directory", strictRoot?: string): Promise<HermesLaunchObjectIdentity> {
  if (linux) {
    const details = await stat(pathname, { bigint: true });
    if (kind === "file" ? !details.isFile() : !details.isDirectory()) throw new Error("SOURCE_ACCEPTANCE_OBJECT_TYPE_INVALID");
    return { platform: "linux", device: String(details.dev), inode: String(details.ino) };
  }
  const args = strictRoot
    ? kind === "file"
      ? ["verify-safe-file-chain", pathname, strictRoot]
      : ["verify-safe-path-chain", kind, pathname, strictRoot]
    : ["verify-safe-path", kind, pathname];
  const expectedStatus = strictRoot ? "SAFE_PATH_FILE_CHAIN" : "SAFE_PATH";
  const invocation = await createWindowsNativeHelperInvocation(profileHelperPath, "hermesProfilePath", args);
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
  if (parsed.status !== expectedStatus || parsed.kind !== kind || !parsed.volumeSerial || !parsed.fileId) {
    throw new Error("SOURCE_ACCEPTANCE_NATIVE_IDENTITY_INVALID");
  }
  return { platform: "win32", volumeSerial: parsed.volumeSerial, fileId: parsed.fileId };
}

function collectNativeHelperEvidence(error: unknown): string {
  const evidence: string[] = [];
  const safeFailureCode = safeRestartChildFailureCode(error);
  if (safeFailureCode) evidence.push(safeFailureCode);
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
      const processOutput = current as { stderr?: unknown; stdout?: unknown };
      const linuxRefusal = safeLinuxRefusalEvidence(
        typeof processOutput.stderr === "string" ? processOutput.stderr : "",
        typeof processOutput.stdout === "string" ? processOutput.stdout : "",
      );
      if (linuxRefusal) evidence.push(linuxRefusal);
      const windowsRefusal = safeWindowsRefusalEvidence(
        typeof processOutput.stderr === "string" ? processOutput.stderr : "",
        typeof processOutput.stdout === "string" ? processOutput.stdout : "",
      );
      if (windowsRefusal) evidence.push(windowsRefusal);
      current = candidate.cause;
    } else break;
  }
  if (evidence.length > 0) return [...new Set(evidence)].join("|");
  return safeHermesLaunchFailureAssertionContext(error);
}

function safeLinuxRefusalEvidence(stderr: string, stdout: string): string | undefined {
  const lines = [stderr, stdout].flatMap((stream) => stream.split(/\r?\n/u)).filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  return /^HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_(?:PROJECTION_UNAVAILABLE|SNAPSHOT_CONTENT_MISMATCH)$/u.test(lines[0]!)
    ? lines[0]
    : undefined;
}

const linuxCacheRootIndexTokens = [...Array.from({ length: 16 }, (_, index) => String(index)), "16_PLUS"];
const linuxCacheRootOpenErrorBuckets = ["NO_ENTRY", "ACCESS_DENIED", "SYMLINK_OR_NOT_DIR", "PATH_TOO_LONG", "OTHER"];
const linuxCacheRootDiagnosticCodes = new Set([
  "HERMES_SOURCE_CACHE_ROOT_PATH_INVALID",
  "HERMES_SOURCE_CACHE_ROOT_FINAL_OWNER_MODE_UNSAFE",
  "HERMES_SOURCE_CACHE_ROOT_METADATA_UNAVAILABLE",
  ...linuxCacheRootOpenErrorBuckets.map((bucket) => `HERMES_SOURCE_CACHE_ROOT_BASE_OPEN_FAILED_${bucket}`),
  ...linuxCacheRootIndexTokens.flatMap((index) => [
    `HERMES_SOURCE_CACHE_ROOT_COMPONENT_METADATA_UNAVAILABLE_${index}`,
    `HERMES_SOURCE_CACHE_ROOT_COMPONENT_OWNER_MODE_UNSAFE_${index}`,
    ...linuxCacheRootOpenErrorBuckets.map((bucket) =>
      `HERMES_SOURCE_CACHE_ROOT_COMPONENT_OPEN_FAILED_${index}_${bucket}`),
  ]),
]);

const linuxNativeRefusalCodes = new Set([
  "HERMES_SOURCE_CACHE_ROOT_OPEN_FAILED",
  "HERMES_SOURCE_CACHE_ROOT_METADATA_UNAVAILABLE",
  "HERMES_SOURCE_CACHE_ROOT_MODE_UNSAFE",
  "HERMES_SOURCE_CACHE_REF_LOCK_OPEN_FAILED",
  "HERMES_SOURCE_CACHE_REF_LOCK_METADATA_INVALID",
  "HERMES_SOURCE_CACHE_REF_LOCK_MODE_UNSAFE",
  "HERMES_SOURCE_CACHE_REF_LOCK_BUSY",
  "HERMES_SOURCE_CACHE_REF_LOCK_FAILED",
  "HERMES_SOURCE_SNAPSHOT_IDENTITY_MISMATCH",
  "HERMES_SOURCE_PROJECTION_UNAVAILABLE",
  "HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH",
  "HERMES_ROOT_PATH_UNSAFE",
  "HERMES_PROFILES_PATH_UNSAFE",
  "HERMES_PROFILE_PATH_UNSAFE",
  "HERMES_PROFILE_IDENTITY_MISMATCH",
  "HERMES_ENTRYPOINT_IDENTITY_MISMATCH",
  "HERMES_PYTHON_IDENTITY_MISMATCH",
  "HERMES_NAMESPACE_CREDENTIALS_UNSUPPORTED",
  "HERMES_PRIVATE_MOUNT_NAMESPACE_UNAVAILABLE",
  "HERMES_PRIVATE_PROFILES_MOUNT_UNAVAILABLE",
  "HERMES_SOURCE_SNAPSHOT_READONLY_MOUNT_UNAVAILABLE",
  "HERMES_SOURCE_SNAPSHOT_MOUNT_VERIFICATION_FAILED",
  "HERMES_PRIVATE_PROFILE_MOUNTPOINT_UNAVAILABLE",
  "HERMES_PROFILE_MOUNT_UNAVAILABLE",
  "HERMES_PROFILE_MOUNT_IDENTITY_MISMATCH",
  "HERMES_PROCESS_SUBREAPER_UNAVAILABLE",
  "HERMES_PYTHON_FORK_FAILED",
  "HERMES_EXECVEAT_FAILED",
  ...linuxCacheRootDiagnosticCodes,
]);

function knownLinuxRefusalCode(line: string): string | undefined {
  const prefix = "HERMES_LINUX_LAUNCH_REFUSED:";
  if (!line.startsWith(prefix)) return undefined;
  const code = line.slice(prefix.length);
  return linuxNativeRefusalCodes.has(code) ? line : undefined;
}

function safeNativeRefusalOutputSummary(output: { exitCode: number; stderr: string; stdout: string } | undefined): string {
  if (!output) return "nativeOutput={available=no,childExitCode=unavailable}";
  const stdoutLines = diagnosticLines(output.stdout);
  const stderrLines = diagnosticLines(output.stderr);
  const allLines = [...stdoutLines, ...stderrLines].filter((line) => line.length > 0);
  const exactRefusal = /^HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_(?:PROJECTION_UNAVAILABLE|SNAPSHOT_CONTENT_MISMATCH)$/u;
  const allowlistedRefusalMatches = allLines.filter((line) => exactRefusal.test(line)).length;
  const knownLinuxRefusals = [...new Set(allLines.flatMap((line) => {
    const refusal = knownLinuxRefusalCode(line);
    return refusal ? [refusal] : [];
  }))].sort();
  const shapeCounts = new Map<string, number>();
  for (const line of allLines) {
    if (knownLinuxRefusalCode(line)) continue;
    const shape = classifyNativeOutputLineShape(line);
    shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
  }
  const shapes = [...shapeCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([shape, count]) => `${shape}:${count}`).join(",") || "none";
  return `nativeOutput={available=yes,childExitCode=${Number.isInteger(output.exitCode) ? output.exitCode : "unknown"},` +
    `stdoutNonEmpty=${output.stdout.length > 0 ? "yes" : "no"},stdoutLineCount=${stdoutLines.length},` +
    `stderrNonEmpty=${output.stderr.length > 0 ? "yes" : "no"},stderrLineCount=${stderrLines.length},` +
    `allowlistedRefusalMatches=${allowlistedRefusalMatches},` +
    `knownLinuxRefusalCodes={${knownLinuxRefusals.join(",") || "none"}},otherLineShapes={${shapes}}}`;
}

function diagnosticLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function classifyNativeOutputLineShape(line: string): string {
  if (/^[A-Z][A-Z0-9_]*(?:\t[A-Z0-9_:-]+)+$/u.test(line)) return "tab-delimited-code";
  if (/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_.-]+)*$/u.test(line)) return "uppercase-code";
  if (/^(?:\{|\[)/u.test(line)) return "json-or-array-shaped";
  if (/^[A-Za-z][A-Za-z0-9_-]*=/u.test(line)) return "key-value-shaped";
  return "other-text-shaped";
}

describe("safe native refusal output diagnostics", () => {
  it("summarizes child output shape without including raw output", () => {
    const rawPath = "C:\\private\\fixture\\source.py";
    const rawSecret = "provider-token-do-not-log";
    const summary = safeNativeRefusalOutputSummary({
      exitCode: 55,
      stdout: `${rawPath}\n`,
      stderr: `token=${rawSecret}\n`,
    });

    expect(summary).toContain("childExitCode=55");
    expect(summary).toContain("stdoutNonEmpty=yes,stdoutLineCount=1");
    expect(summary).toContain("stderrNonEmpty=yes,stderrLineCount=1");
    expect(summary).toContain("allowlistedRefusalMatches=0");
    expect(summary).toContain("otherLineShapes={key-value-shaped:1,other-text-shaped:1}");
    expect(summary).not.toContain(rawPath);
    expect(summary).not.toContain(rawSecret);
  });

  it("counts only exact allowlisted refusal lines", () => {
    const summary = safeNativeRefusalOutputSummary({
      exitCode: 1,
      stdout: "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_PROJECTION_UNAVAILABLE\n",
      stderr: "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_PROJECTION_UNAVAILABLE:extra\n",
    });

    expect(summary).toContain("allowlistedRefusalMatches=1");
    expect(summary).toContain("otherLineShapes={other-text-shaped:1}");
  });

  it("reports a known Linux refusal code without accepting it as expected evidence", () => {
    const refusal = "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_CACHE_REF_LOCK_BUSY";
    const summary = safeNativeRefusalOutputSummary({
      exitCode: 65,
      stdout: "",
      stderr: `${refusal}\n`,
    });

    expect(summary).toContain(`knownLinuxRefusalCodes={${refusal}}`);
    expect(summary).toContain("allowlistedRefusalMatches=0");
    expect(summary).toContain("otherLineShapes={none}");
  });

  it("keeps cache lease diagnostics outside accepted EHSP refusal evidence", () => {
    expect(safeLinuxRefusalEvidence(
      "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_CACHE_REF_LOCK_BUSY\n",
      "",
    )).toBeUndefined();
    expect(safeLinuxRefusalEvidence(
      "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH\n",
      "",
    )).toBe("HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH");
  });

  it("reports bounded cache-root path-walk diagnostics as known unexpected refusals only", () => {
    const diagnosticCodes = [
      "HERMES_SOURCE_CACHE_ROOT_PATH_INVALID",
      "HERMES_SOURCE_CACHE_ROOT_BASE_OPEN_FAILED_ACCESS_DENIED",
      "HERMES_SOURCE_CACHE_ROOT_COMPONENT_OPEN_FAILED_0_NO_ENTRY",
      "HERMES_SOURCE_CACHE_ROOT_COMPONENT_OPEN_FAILED_16_PLUS_SYMLINK_OR_NOT_DIR",
      "HERMES_SOURCE_CACHE_ROOT_COMPONENT_METADATA_UNAVAILABLE_3",
      "HERMES_SOURCE_CACHE_ROOT_COMPONENT_OWNER_MODE_UNSAFE_2",
      "HERMES_SOURCE_CACHE_ROOT_FINAL_OWNER_MODE_UNSAFE",
    ];

    for (const code of diagnosticCodes) {
      const refusal = `HERMES_LINUX_LAUNCH_REFUSED:${code}`;
      const summary = safeNativeRefusalOutputSummary({ exitCode: 65, stdout: "", stderr: `${refusal}\n` });
      expect(summary).toContain(`knownLinuxRefusalCodes={${refusal}}`);
      expect(summary).toContain("allowlistedRefusalMatches=0");
      expect(safeLinuxRefusalEvidence(`${refusal}\n`, "")).toBeUndefined();
    }

    const unboundedDiagnostic = "HERMES_LINUX_LAUNCH_REFUSED:HERMES_SOURCE_CACHE_ROOT_COMPONENT_OPEN_FAILED_999_ERRNO_13";
    const summary = safeNativeRefusalOutputSummary({ exitCode: 65, stdout: "", stderr: `${unboundedDiagnostic}\n` });
    expect(summary).toContain("knownLinuxRefusalCodes={none}");
    expect(safeLinuxRefusalEvidence(`${unboundedDiagnostic}\n`, "")).toBeUndefined();
  });

  it("hides unknown uppercase codes and raw secret text", () => {
    const unknownCode = "HERMES_PRIVATE_UNRECOGNIZED_FAILURE";
    const rawSecret = "provider-token-do-not-log";
    const summary = safeNativeRefusalOutputSummary({
      exitCode: 65,
      stdout: `${unknownCode}\n`,
      stderr: `token=${rawSecret}\n`,
    });

    expect(summary).not.toContain(unknownCode);
    expect(summary).not.toContain(rawSecret);
    expect(summary).toContain("knownLinuxRefusalCodes={none}");
    expect(summary).toContain("otherLineShapes={key-value-shaped:1,uppercase-code:1}");
  });
});

function safeWindowsRefusalEvidence(stderr: string, stdout: string): string | undefined {
  const lines = [stderr, stdout].flatMap((stream) => stream.split(/\r?\n/u)).filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  const line = lines[0]!;
  const direct = /^WINDOWS_HELPER_NATIVE_UNKNOWN:(LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE|LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH(?::CONTENT_MISMATCH)?)$/u.exec(line);
  if (direct) return line;
  const native = /^UNKNOWN\t(LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE|LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH)(?:\t(CONTENT_MISMATCH))?$/u.exec(line);
  if (!native) return undefined;
  return `WINDOWS_HELPER_NATIVE_UNKNOWN:${native[1]}${native[2] ? `:${native[2]}` : ""}`;
}

async function resolveVerifiedSystemPowerShellPath(): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runVerifiedNativeHelper(profileHelperPath, "hermesProfilePath", ["verify-windows-system-powershell"], {
      cwd: repositoryRoot, timeout: 15_000, maxBuffer: 8_192,
    });
  } catch {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_VERIFICATION_FAILED");
  }
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > 8_192) {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_VERIFICATION_FAILED");
  }
  const line = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2)
    : result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(line) as unknown; } catch {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  const identity = parsed as Record<string, unknown>;
  if (Object.keys(identity).sort().join(",") !== "fileId,kind,path,status,volumeSerial" ||
      identity.status !== "SAFE_PATH" || identity.kind !== "file" || typeof identity.path !== "string" ||
      typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId) ||
      typeof identity.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(identity.volumeSerial)) {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  const reportedPath = identity.path.startsWith("\\\\?\\") ? identity.path.slice(4) : identity.path;
  const root = win32.parse(reportedPath).root;
  if (!/^[A-Za-z]:\\$/u.test(root) || !win32.isAbsolute(reportedPath) ||
      !reportedPath.toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe")) {
    throw new Error("SOURCE_ACCEPTANCE_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  return reportedPath;
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
