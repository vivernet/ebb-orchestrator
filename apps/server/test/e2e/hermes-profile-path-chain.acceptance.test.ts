import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { consumeHermesLaunchTicket, createHermesLaunchTicket, type HermesLaunchObjectIdentity } from "../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { ensureHermesSourceSnapshotNativeProjection, materializeHermesSourceSnapshot } from "../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { prepareRunProcessOwner } from "../../src/modules/runtime/run-process-owner.js";
import { ExitCodeError, ProcessExecutor } from "../../src/platform/process/process-executor.js";
import {
  WindowsJobSupervisor,
  WindowsPathChainEvidenceParser,
  WINDOWS_PATH_CHAIN_EVIDENCE_STAGES,
} from "../../src/platform/process/windows-job-supervisor.js";
import { createWindowsNativeHelperInvocation } from "../../src/platform/process/windows-native-helper-launcher.js";
import { verifyNativeHelperIntegrity } from "../../src/platform/process/native-helper-integrity.js";
import type { ProcessScopeHandle } from "../../src/platform/process/run-scope-supervisor.js";
import { verifyHermesProfileHomePathChain } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";
import { createProductionPaths } from "../../src/platform/home/production-paths.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import {
  isSafeHermesPathComponentAclDiagnostic,
  sanitizeHermesPathIdentityDiagnostic,
  withHermesSourceSnapshotFailureObserver,
  type HermesSourceSnapshotDiagnosticPhase,
} from "../../src/modules/runtime/hermes/hermes-source-snapshot-diagnostics.js";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import { createPinnedGitFixture } from "../helpers/hermes-source-snapshot-acceptance-fixture.js";
import {
  safeHermesLaunchFailureAssertionContext,
  safeHermesProfileChainLaunchEvidence,
} from "../helpers/safe-hermes-profile-chain-message.js";

const enabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1" && process.platform === "win32";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const profileHelper = join(repo, "apps/server/dist/native/hermes-profile-path/ebb-hermes-profile-path.exe");
const supervisorHelper = join(repo, "apps/server/dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
const pinnedHermesVersion = "v0.21.5+9117.g08165d5";

interface VerifiedWindowsSystemPaths {
  readonly powershell: string;
  readonly system32: string;
  readonly systemRoot: string;
  readonly volumeRoot: string;
}

interface ManagedFixtureHome {
  path: string;
  identityProbe: string;
  strictRoot: string;
  identity: HermesLaunchObjectIdentity | undefined;
  launchAttempted: boolean;
  launchAttempts: Array<{
    identity: ProcessScopeIdentity | undefined;
    attemptAwareStopRequired: boolean;
  }>;
  unprovenLaunch: boolean;
}

const originalSystemRootAliases = {
  SystemRoot: process.env.SystemRoot,
  SYSTEMROOT: process.env.SYSTEMROOT,
};
let verifiedWindowsSystemPaths: VerifiedWindowsSystemPaths | undefined;

describe.skipIf(!enabled)("Windows Hermes profile path-chain production integration", () => {
  const executor = new ProcessExecutor();
  const supervisor = new WindowsJobSupervisor(executor, supervisorHelper);
  const fixtureHomes: ManagedFixtureHome[] = [];

  afterAll(async () => {
    try {
      for (const fixtureHome of fixtureHomes.reverse()) {
        if (fixtureHome.launchAttempted && (fixtureHome.unprovenLaunch || fixtureHome.launchAttempts.length === 0 ||
            fixtureHome.launchAttempts.some((attempt) => !attempt.identity))) {
          throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN");
        }
        for (const attempt of fixtureHome.launchAttempts) {
          if (!attempt.identity) throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN");
          let observation;
          try {
            observation = await supervisor.waitForStopped(attempt.identity, 30_000);
          } catch (error) {
            throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN", { cause: error });
          }
          if (observation.state !== "STOPPED" ||
              (attempt.attemptAwareStopRequired && observation.evidence !== "WINDOWS_ATTEMPT_SCOPE_ABSENT")) {
            throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN", { cause: observation });
          }
        }
        if (!fixtureHome.identity) throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_IDENTITY_UNPROVEN");
        const currentIdentity = await nativeIdentity(
          fixtureHome.identityProbe, "directory", fixtureHome.strictRoot, "strict-root",
        );
        if (!sameNativeIdentity(currentIdentity, fixtureHome.identity)) {
          throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_IDENTITY_CHANGED");
        }
        // Repeat the attempt-bound readback at the cleanup boundary, after identity checks.
        // A prior STOPPED observation is not reused as authority for deleting the fixture.
        for (const attempt of fixtureHome.launchAttempts) {
          if (!attempt.identity) throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN");
          const finalObservation = await supervisor.waitForStopped(attempt.identity, 30_000).catch((error: unknown) => {
            throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN", { cause: error });
          });
          if (finalObservation.state !== "STOPPED" ||
              (attempt.attemptAwareStopRequired && finalObservation.evidence !== "WINDOWS_ATTEMPT_SCOPE_ABSENT")) {
            throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_STOP_UNPROVEN", { cause: finalObservation });
          }
        }
        await removeWindowsFixtureTree(fixtureHome.path, fixtureHome.identity);
      }
    } finally {
      restoreSystemRootAliases();
      verifiedWindowsSystemPaths = undefined;
    }
  }, 300_000);

  async function launchForFixture(
    launchSupervisor: WindowsJobSupervisor,
    fixture: Awaited<ReturnType<typeof makeFixture>>,
    expectedOwner: ProcessScopeIdentity,
    start: (publishIdentity: (identity: ProcessScopeIdentity) => Promise<void>) => Promise<ProcessScopeHandle>,
    onIdentity: (identity: ProcessScopeIdentity) => Promise<void> = async () => {},
  ): Promise<ProcessScopeHandle> {
    const managed = fixture.managedHome;
    const attempt = {
      identity: undefined as ProcessScopeIdentity | undefined,
      attemptAwareStopRequired: false,
    };
    managed.launchAttempted = true;
    managed.launchAttempts.push(attempt);
    let identityPublished = false;
    try {
      const handle = await start(async (identity) => {
        if (identityPublished) {
          managed.unprovenLaunch = true;
          throw new Error("PROFILE_PATH_CHAIN_FIXTURE_LAUNCH_IDENTITY_DUPLICATE");
        }
        if (identity.runId !== fixture.runId || identity.runId !== expectedOwner.runId ||
            identity.containmentId !== expectedOwner.containmentId || identity.launchNonce !== expectedOwner.launchNonce ||
            identity.containmentKind !== expectedOwner.containmentKind) {
          managed.unprovenLaunch = true;
          throw new Error("PROFILE_PATH_CHAIN_FIXTURE_LAUNCH_IDENTITY_MISMATCH");
        }
        identityPublished = true;
        attempt.identity = identity;
        await onIdentity(identity);
      });
      if (!identityPublished) {
        managed.unprovenLaunch = true;
        throw new Error("PROFILE_PATH_CHAIN_FIXTURE_LAUNCH_IDENTITY_MISSING");
      }
      return handle;
    } catch (error) {
      if (!identityPublished) {
        // PREPARED and the absence of EBB_SCOPE_READY do not prove that CreateProcessW was
        // never attempted. Only the supervisor's attempt-scoped, settled-session readback
        // can authorize cleanup after a pre-READY launch failure.
        const stopped = await launchSupervisor.waitForStopped(expectedOwner, 30_000).catch(() => undefined);
        if (stopped?.state === "STOPPED" && stopped.evidence === "WINDOWS_ATTEMPT_SCOPE_ABSENT") {
          attempt.identity = expectedOwner;
          attempt.attemptAwareStopRequired = true;
        } else {
          managed.unprovenLaunch = true;
        }
      }
      throw error;
    }
  }

  it("rejects a Run-profile ACL change in the suspended CreateProcessW-to-ACK window", async () => {
    const fixture = await makeFixture(fixtureHomes);
    const marker = join(fixture.root, "must-not-run.marker");
    const args = ["-I", "-B", "-S", "-c", `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ran')`];
    const ticket = await makeTicket(fixture, args);
    expect(await verifyHermesProfileHomePathChain(fixture.profile, fixture.authRoot))
      .toEqual(fixture.profileHomePathChain);
    const owner = prepareRunProcessOwner(fixture.runId, fixture.profile, "windows-job", fixture.snapshot.cacheKey);
    let publishedIdentity: Awaited<ReturnType<typeof ownerIdentity>> | undefined;
    let error: unknown;
    let completion: { exitCode: number; stderr: string; stdout: string } | undefined;
    let aclMutationAttempted = false;
    let stopProven = false;

    try {
      try {
        const handle = await launchForFixture(supervisor, fixture, ownerIdentity(owner), (publishIdentity) => supervisor.launch(ownerIdentity(owner), {
          executable: fixture.python, args, cwd: fixture.root, environment: fixture.environment,
          attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
        }, publishIdentity), async (identity) => {
          publishedIdentity = identity;
          // This callback runs after CreateProcessW(CREATE_SUSPENDED) and before the nonce ACK.
          aclMutationAttempted = true;
          await addForeignWriteAce(fixture.profile, fixture.systemPaths);
        });
        completion = await handle.completion;
      } catch (caught) {
        error = caught;
      }

      const launchFailureCode = safeHermesLaunchFailureAssertionContext(error);
      expect(publishedIdentity, `the production supervisor must publish the suspended Job identity (${launchFailureCode})`).toBeDefined();
      const stopped = await supervisor.waitForStopped(publishedIdentity!, 30_000);
      stopProven = stopped.state === "STOPPED";
      expect(stopped.state, "native refusal must prove the entire Job stopped").toBe("STOPPED");
      expect(await exists(marker), "the suspended child must not execute after the ACL changed").toBe(false);
      const evidence = safeHermesProfileChainLaunchEvidence(error, completion?.stdout, completion?.stderr, completion?.exitCode);
      expect(evidence, `native refusal evidence (${launchFailureCode})`).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    } finally {
      // If STOPPED cannot be proven, preserve the mutated fixture for diagnosis/recovery.
      if (aclMutationAttempted && stopProven) await removeForeignWriteAce(fixture.profile, fixture.systemPaths);
    }
  }, 180_000);

  it("fails closed when the captured Run leaf is missing and an attacker races to create it", async () => {
    const fixture = await makeFixture(fixtureHomes);
    const marker = join(fixture.root, "missing-leaf-must-not-run.marker");
    const args = ["-I", "-B", "-S", "-c", `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ran')`];
    const ticket = await makeTicket(fixture, args);
    const owner = prepareRunProcessOwner(fixture.runId, fixture.profile, "windows-job", fixture.snapshot.cacheKey);
    const originalProfile = `${fixture.profile}.captured`;
    await rename(fixture.profile, originalProfile);

    let launchSettled = false;
    let creatorAttemptedWhileLaunchPending = false;
    let leafRaceOutcome: "NATIVE_REJECTED_BEFORE_CREATOR" | "CREATOR_CREATED_IMPOSTOR" =
      "NATIVE_REJECTED_BEFORE_CREATOR";
    let error: unknown;
    let completion: { exitCode: number; stderr: string; stdout: string } | undefined;
    const launchedIdentities: ProcessScopeIdentity[] = [];
    const launch = launchForFixture(supervisor, fixture, ownerIdentity(owner), (publishIdentity) => supervisor.launch(ownerIdentity(owner), {
      executable: fixture.python, args, cwd: fixture.root, environment: fixture.environment,
      attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
    }, publishIdentity), async (identity) => { launchedIdentities.push(identity); })
      .then(async (handle) => { completion = await handle.completion; }, (caught: unknown) => { error = caught; })
      .finally(() => { launchSettled = true; });

    // Keep attempting the exact absent leaf while the real helper/supervisor launch is in flight.
    // Either the helper observes ENOENT, or this creator wins and the ticket identity must reject
    // the impostor before CreateProcessW can dispatch the payload.
    const creator = (async () => {
      if (launchSettled) return;
      // Record immediately before issuing mkdir so this proves an actual creator attempt was
      // dispatched while the production launch Promise was still pending.
      creatorAttemptedWhileLaunchPending = true;
      try {
        await mkdir(fixture.profile);
        leafRaceOutcome = "CREATOR_CREATED_IMPOSTOR";
      } catch (caught) {
        if (isErrno(caught, "EEXIST")) {
          throw new Error("PROFILE_PATH_CHAIN_RACE_UNEXPECTED_LEAF_ALREADY_PRESENT", { cause: caught });
        }
        throw caught;
      }
    })();

    try {
      const settled = await Promise.allSettled([launch, creator]);
      if (settled[1]?.status === "rejected") throw settled[1].reason;
      // Either the helper refused the missing leaf before the creator's next scheduling turn,
      // or creation won and the captured ticket rejected that replacement identity.
      if (creatorAttemptedWhileLaunchPending) {
        expect(leafRaceOutcome).not.toBe("NATIVE_REJECTED_BEFORE_CREATOR");
      } else {
        expect(launchSettled, "the only valid no-attempt outcome is native refusal before the creator runs").toBe(true);
        expect(leafRaceOutcome).toBe("NATIVE_REJECTED_BEFORE_CREATOR");
      }
      expect(await exists(marker), "neither a missing nor impostor leaf may dispatch the payload").toBe(false);
      const launchFailureCode = safeHermesLaunchFailureAssertionContext(error);
      expect(safeHermesProfileChainLaunchEvidence(error, completion?.stdout, completion?.stderr, completion?.exitCode),
        `missing-leaf refusal evidence (${launchFailureCode})`)
        .toBe("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    } finally {
      await requireScopesStopped(launchedIdentities);
      if (await exists(fixture.profile)) await rmdir(fixture.profile);
      await rename(originalProfile, fixture.profile);
    }
  }, 180_000);

  it("rejects an impostor already occupying the captured Run leaf", async () => {
    const fixture = await makeFixture(fixtureHomes);
    const marker = join(fixture.root, "impostor-must-not-run.marker");
    const args = ["-I", "-B", "-S", "-c", `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ran')`];
    const ticket = await makeTicket(fixture, args);
    const owner = prepareRunProcessOwner(fixture.runId, fixture.profile, "windows-job", fixture.snapshot.cacheKey);
    const originalProfile = `${fixture.profile}.captured`;
    await rename(fixture.profile, originalProfile);
    await mkdir(fixture.profile);
    await setPrivateOwnerAcl([fixture.profile], fixture.systemPaths);
    await mkdir(join(fixture.profile, "home"));
    await writeFile(join(fixture.profile, "config.yaml"), "impostor config\n");
    await setPrivateOwnerAcl([join(fixture.profile, "home"), join(fixture.profile, "config.yaml")], fixture.systemPaths);

    let error: unknown;
    let completion: { exitCode: number; stderr: string; stdout: string } | undefined;
    const launchedIdentities: ProcessScopeIdentity[] = [];
    try {
      const handle = await launchForFixture(supervisor, fixture, ownerIdentity(owner), (publishIdentity) => supervisor.launch(ownerIdentity(owner), {
        executable: fixture.python, args, cwd: fixture.root, environment: fixture.environment,
        attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
      }, publishIdentity), async (identity) => { launchedIdentities.push(identity); });
      completion = await handle.completion;
    } catch (caught) {
      error = caught;
    } finally {
      await requireScopesStopped(launchedIdentities);
      await rm(fixture.profile, { recursive: true, force: true });
      await rename(originalProfile, fixture.profile);
    }
    expect(await exists(marker), "the ticket must not authorize a replacement profile").toBe(false);
    const launchFailureCode = safeHermesLaunchFailureAssertionContext(error);
    expect(safeHermesProfileChainLaunchEvidence(error, completion?.stdout, completion?.stderr, completion?.exitCode),
      `impostor-profile refusal evidence (${launchFailureCode})`)
      .toBe("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
  }, 180_000);

  it("rejects an ancestor rename and reparse substitution before payload dispatch", async () => {
    const fixture = await makeFixture(fixtureHomes);
    const marker = join(fixture.root, "ancestor-substitution-must-not-run.marker");
    const args = ["-I", "-B", "-S", "-c", `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ran')`];
    const ticket = await makeTicket(fixture, args);
    const owner = prepareRunProcessOwner(fixture.runId, fixture.profile, "windows-job", fixture.snapshot.cacheKey);
    const movedProfiles = `${join(fixture.authRoot, "profiles")}.captured`;
    await rename(join(fixture.authRoot, "profiles"), movedProfiles);
    const junctionPath = join(fixture.authRoot, "profiles");
    let junctionCreated = false;
    const launchedIdentities: ProcessScopeIdentity[] = [];
    try {
      await createDirectoryJunction(junctionPath, movedProfiles, fixture.systemPaths);
      junctionCreated = true;
      let error: unknown;
      let completion: { exitCode: number; stderr: string; stdout: string } | undefined;
      try {
        const handle = await launchForFixture(supervisor, fixture, ownerIdentity(owner), (publishIdentity) => supervisor.launch(ownerIdentity(owner), {
          executable: fixture.python, args, cwd: fixture.root, environment: fixture.environment,
          attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
        }, publishIdentity), async (identity) => { launchedIdentities.push(identity); });
        completion = await handle.completion;
      } catch (caught) {
        error = caught;
      }
      expect(await exists(marker), "a reparse substitution must not dispatch the payload").toBe(false);
      const launchFailureCode = safeHermesLaunchFailureAssertionContext(error);
      expect(safeHermesProfileChainLaunchEvidence(error, completion?.stdout, completion?.stderr, completion?.exitCode),
        `ancestor-substitution refusal evidence (${launchFailureCode})`)
        .toBe("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    } finally {
      await requireScopesStopped(launchedIdentities);
      if (junctionCreated) await rmdir(junctionPath);
      await rename(movedProfiles, junctionPath);
    }
  }, 180_000);

  it("keeps the production Job live until release and performs fixture cleanup only after STOPPED", async () => {
    const fixture = await makeFixture(fixtureHomes);
    const marker = join(fixture.root, "payload.marker");
    const release = join(fixture.root, "payload.release");
    const profilesPath = join(fixture.authRoot, "profiles");
    const movedProfilesPath = `${profilesPath}.live-captured`;
    const impostorProfilesPath = join(fixture.root, "live-impostor-profiles");
    const impostorProfilePath = join(impostorProfilesPath, fixture.profile.split(/[\\/]/u).at(-1)!);
    const impostorHomePath = join(impostorProfilePath, "home");
    await mkdir(impostorHomePath, { recursive: true });
    await writeFile(join(impostorProfilePath, "config.yaml"), "live reparse impostor\n");
    await setPrivateOwnerAcl([impostorProfilesPath, impostorProfilePath, impostorHomePath, join(impostorProfilePath, "config.yaml")], fixture.systemPaths);
    const args = ["-I", "-B", "-S", "-c", [
      "from pathlib import Path",
      "import os",
      "import time",
      `Path(${JSON.stringify(marker)}).write_text('started')`,
      `release = Path(${JSON.stringify(release)})`,
      "while not release.exists(): time.sleep(0.02)",
      "Path(os.environ['HERMES_HOME'], 'home', 'live-path.marker').write_text('routed')",
    ].join("\n")];
    const ticket = await makeTicket(fixture, args);
    const owner = prepareRunProcessOwner(fixture.runId, fixture.profile, "windows-job", fixture.snapshot.cacheKey);
    const launchOwner = ownerIdentity(owner);
    const evidenceExpectedDigests = Object.fromEntries(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.map((stage) => [
      stage, expectedPathChainEvidenceDigest(stage, fixture.runId, fixture.profileHomePathChain, fixture.targetIdentities),
    ])) as Record<(typeof WINDOWS_PATH_CHAIN_EVIDENCE_STAGES)[number], string>;
    const evidenceParser = new WindowsPathChainEvidenceParser({
      containmentId: launchOwner.containmentId,
      runId: fixture.runId,
      launchNonce: launchOwner.launchNonce,
      expectedDigests: evidenceExpectedDigests,
    });
    const evidenceSupervisor = new WindowsJobSupervisor(executor, supervisorHelper, undefined, {
      binding: {
        containmentId: launchOwner.containmentId,
        runId: fixture.runId,
        launchNonce: launchOwner.launchNonce,
        expectedDigests: evidenceExpectedDigests,
      },
      parser: evidenceParser,
    });
    let identity: Awaited<ReturnType<typeof ownerIdentity>> | undefined;
    let suspendedPhase: string | undefined;
    let profileRenameDenied = false;
    let ancestorRenameDenied = false;
    let ancestorDeleteDenied = false;
    let liveAncestorDeleteDenied = false;
    let liveAncestorSubstitution: "RENAME_DENIED" | "JUNCTION_INSTALLED" | undefined;
    let liveChainStillMatches = false;
    const identityPathMarker = join(fixture.home, "live-path.marker");
    const impostorPathMarker = join(impostorHomePath, "live-path.marker");
    const movedOriginalPathMarker = join(movedProfilesPath, fixture.profile.split(/[\\/]/u).at(-1)!, "home", "live-path.marker");
    const handle = await launchForFixture(evidenceSupervisor, fixture, launchOwner, (publishIdentity) => evidenceSupervisor.launch(launchOwner, {
      executable: fixture.python, args, cwd: fixture.root, environment: fixture.environment,
      attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000,
    }, publishIdentity), async (value) => {
      identity = value;
      suspendedPhase = await supervisor.inspectLaunchPhase(value);
      expect(await verifyHermesProfileHomePathChain(fixture.profile, fixture.authRoot))
        .toEqual(fixture.profileHomePathChain);
      expect(sameNativeIdentity(
        await nativeIdentity(fixture.home, "directory", fixture.strictBoundary), fixture.targetIdentities.home,
      )).toBe(true);
      expect(sameNativeIdentity(
        await nativeIdentity(fixture.config, "file", fixture.strictBoundary), fixture.targetIdentities.config,
      )).toBe(true);
      profileRenameDenied = await renameDenied(fixture.profile, `${fixture.profile}.during-launch`);
      const profiles = join(fixture.authRoot, "profiles");
      ancestorRenameDenied = await renameDenied(profiles, `${profiles}.during-launch`);
      try {
        await rm(fixture.authRoot, { recursive: true, force: true });
      } catch {
        ancestorDeleteDenied = true;
      }
    });
    let actionFailure: unknown;
    let releaseFailure: unknown;
    let completionFailure: unknown;
    let completion: Awaited<typeof handle.completion> | undefined;
    try {
      await waitForFile(marker);
      expect(identity).toBeDefined();
      expect(suspendedPhase, "the production callback must observe the native child waiting before ACK").toBe("WAITING_FOR_ACK");
      expect(profileRenameDenied, "the native chain handle must deny deleting/renaming the exact Run leaf before resume").toBe(true);
      expect(ancestorRenameDenied, "the native chain handle must deny deleting/renaming a pinned ancestor before resume").toBe(true);
      expect(ancestorDeleteDenied, "the native chain handles must deny recursive deletion of the auth-root ancestor before resume").toBe(true);
      expect((await supervisor.inspect(identity!)).state).toBe("LIVE");
      const liveProfileRenameDenied = await renameDenied(fixture.profile, `${fixture.profile}.while-live`);
      try {
        await rm(fixture.authRoot, { recursive: true, force: true });
      } catch {
        liveAncestorDeleteDenied = true;
      }
      expect(liveProfileRenameDenied, "a LIVE production Job must retain no-delete-sharing handles for the exact Run leaf").toBe(true);
      expect(liveAncestorDeleteDenied, "a LIVE production Job must retain no-delete-sharing handles for its auth-root ancestry").toBe(true);
      liveAncestorSubstitution = await attemptLiveAncestorJunction(
        profilesPath, movedProfilesPath, impostorProfilesPath, fixture.systemPaths,
      );
      liveChainStillMatches = liveAncestorSubstitution === "RENAME_DENIED" &&
        await verifyHermesProfileHomePathChain(fixture.profile, fixture.authRoot)
          .then((chain) => JSON.stringify(chain) === JSON.stringify(fixture.profileHomePathChain), () => false);
      if (liveAncestorSubstitution === "RENAME_DENIED") {
        expect(sameNativeIdentity(await nativeIdentity(fixture.profile, "directory", fixture.strictBoundary), fixture.profileIdentity)).toBe(true);
        expect(sameNativeIdentity(await nativeIdentity(fixture.home, "directory", fixture.strictBoundary), fixture.targetIdentities.home)).toBe(true);
        expect(sameNativeIdentity(await nativeIdentity(fixture.config, "file", fixture.strictBoundary), fixture.targetIdentities.config)).toBe(true);
      }
    } catch (error) {
      actionFailure = error;
    } finally {
      // The dummy payload waits only on this fixture-local release file. Always release it before
      // marker polling or assertions can fail, so authoritative STOPPED proof remains reachable.
      try { await writeFile(release, "release"); } catch (error) { releaseFailure = error; }
    }
    try { completion = await handle.completion; } catch (error) { completionFailure = error; }
    const finalObservation = await supervisor.waitForStopped(identity!, 30_000);
    if (finalObservation.state !== "STOPPED") {
      throw new Error("PROFILE_PATH_CHAIN_LIVE_FIXTURE_STOP_UNPROVEN", { cause: finalObservation });
    }
    if (releaseFailure) throw new Error("PROFILE_PATH_CHAIN_LIVE_FIXTURE_RELEASE_FAILED", { cause: releaseFailure });
    if (completionFailure) throw completionFailure;
    if (actionFailure) throw actionFailure;
    if (!completion) throw new Error("PROFILE_PATH_CHAIN_LIVE_FIXTURE_COMPLETION_MISSING");
    expect(evidenceParser.result?.records.map((record) => record.stage)).toEqual(WINDOWS_PATH_CHAIN_EVIDENCE_STAGES);
    expect(completion.stdout).not.toContain("EBB_EVIDENCE");
    expect((await supervisor.waitForStopped(identity!, 30_000)).state).toBe("STOPPED");
    const routedToImpostor = await exists(impostorPathMarker);
    const routedToCapturedProfile = await exists(liveAncestorSubstitution === "JUNCTION_INSTALLED"
      ? movedOriginalPathMarker
      : identityPathMarker);
    if (liveAncestorSubstitution === "JUNCTION_INSTALLED") {
      await rmdir(profilesPath);
      await rename(movedProfilesPath, profilesPath);
    }
    expect(liveAncestorSubstitution, "the LIVE supervisor must deny renaming the pinned profiles ancestor before a junction can replace it")
      .toBe("RENAME_DENIED");
    expect(routedToImpostor, "the release payload must not follow a fixture-local reparse replacement into the impostor profile")
      .toBe(false);
    expect(routedToCapturedProfile, "the payload must resolve HERMES_HOME to the captured profile after the attack attempt")
      .toBe(true);
    // The Python fixture creates this marker after launch, so its process-token default DACL may
    // add a logon-session ACE. Once STOPPED is proven, seal only this test-owned marker to the
    // fixture owner before the handle-relative native tree cleanup evaluates the whole tree.
    await setPrivateOwnerAcl([identityPathMarker], fixture.systemPaths);
    expect(liveChainStillMatches, "the path-chain identity match captured while the production Job was LIVE must remain valid").toBe(true);
    expect(await readFile(marker, "utf8")).toBe("started");
    expect(sameNativeIdentity(await nativeIdentity(fixture.profile, "directory", fixture.strictBoundary), fixture.profileIdentity),
      "the exact captured Run leaf identity must remain the same through STOPPED cleanup").toBe(true);
    expect(await verifyHermesProfileHomePathChain(fixture.profile, fixture.authRoot)).toEqual(fixture.profileHomePathChain);
    expect(sameNativeIdentity(await nativeIdentity(fixture.home, "directory", fixture.strictBoundary), fixture.targetIdentities.home)).toBe(true);
    expect(sameNativeIdentity(await nativeIdentity(fixture.config, "file", fixture.strictBoundary), fixture.targetIdentities.config)).toBe(true);
    // Namespace locking is not a same-user ACL freeze; cleanup starts only after STOPPED.
    await rm(fixture.config);
  }, 180_000);

  async function makeFixture(
    homes: ManagedFixtureHome[],
  ) {
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    if (!localAppData || !userProfile || !(await existingRealDirectory(userProfile)) ||
        !(await existingRealDirectory(localAppData))) {
      throw new Error("PROFILE_PATH_CHAIN_LOCALAPPDATA_UNAVAILABLE");
    }
    const localAppDataRelative = relative(userProfile, localAppData);
    if (!localAppDataRelative || localAppDataRelative === ".." || localAppDataRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(localAppDataRelative)) {
      throw new Error("PROFILE_PATH_CHAIN_LOCALAPPDATA_OUTSIDE_USERPROFILE");
    }
    // Keep fixture placement independent from TEMP/TMP: the native PowerShell launcher needs a
    // user-writable temp directory for Add-Type, while this opt-in root override can place the
    // disposable path-chain directly under a volume root whose bounded exception is policy-approved.
    const fixtureRootOverride = process.env.EBB_PROFILE_CHAIN_FIXTURE_ROOT;
    const fixtureRoot = fixtureRootOverride ? resolve(fixtureRootOverride) : tmpdir();
    const systemPaths = await getVerifiedWindowsSystemPaths();
    setSystemRootAliases(systemPaths.systemRoot);
    const systemVolumeRoot = systemPaths.volumeRoot;
    if (fixtureRootOverride && (!isAbsolute(fixtureRootOverride) || !/^[A-Za-z]:\\$/u.test(fixtureRoot) ||
        !systemVolumeRoot || fixtureRoot.toLowerCase() !== systemVolumeRoot.toLowerCase())) {
      throw new Error("PROFILE_PATH_CHAIN_FIXTURE_ROOT_MUST_BE_LOCAL_SYSTEM_VOLUME_ROOT");
    }
    if (!(await existingRealDirectory(fixtureRoot))) throw new Error("PROFILE_PATH_CHAIN_FIXTURE_ROOT_UNAVAILABLE");
    const fixtureParent = join(fixtureRoot, `ebb-orchestrator-profile-chain-e2e-${randomUUID()}`);
    const homeRoot = join(fixtureParent, "home");
    const managedHome = {
      path: fixtureParent,
      identityProbe: homeRoot,
      strictRoot: fixtureParent,
      identity: undefined as HermesLaunchObjectIdentity | undefined,
      launchAttempted: false,
      launchAttempts: [] as Array<{
        identity: ProcessScopeIdentity | undefined;
        attemptAwareStopRequired: boolean;
      }>,
      unprovenLaunch: false,
    };
    const previousHomeOverride = process.env.EBB_ORCHESTRATOR_HOME;
    try {
      // Register the candidate before creation. If its identity cannot be proven, afterAll sees
      // the missing identity and deliberately retains the candidate instead of deleting by path.
      homes.push(managedHome);
      // Apply the protected owner-only DACL in the CreateDirectory call itself. The volume-root
      // inheritance must never expose a newly created fixture before it becomes the strict boundary.
      await createPrivateOwnerFixtureDirectory(fixtureParent, systemPaths);
      await mkdir(homeRoot);
      await setPrivateOwnerAcl([homeRoot], systemPaths);
      // Capture the temporary strict-boundary directory from a verified descendant chain. Do not
      // use legacy verify-safe-path on fixtureParent: that command applies strict ACL checks to
      // real temporary-directory ancestors outside this fixture.
      managedHome.identity = await nativeIdentity(homeRoot, "directory", fixtureParent, "strict-root");
      process.env.EBB_ORCHESTRATOR_HOME = homeRoot;
      const productionHome = resolveOrchestratorHome(process.env, "win32");
      const productionCacheRoot = createProductionPaths(productionHome).hermesSourceSnapshotCacheRoot;
      if (resolve(productionHome.root) !== resolve(homeRoot)) {
        throw new Error("PROFILE_PATH_CHAIN_FIXTURE_HOME_RESOLUTION_MISMATCH");
      }

      // Build the production cache beneath the isolated home; all strict checks below retain the
      // temporary fixture parent as their boundary and therefore include the complete owned path.
      const cacheParent = dirname(productionCacheRoot);
      const runtimeRoot = dirname(cacheParent);
      await mkdir(runtimeRoot);
      await setPrivateOwnerAcl([runtimeRoot], systemPaths);
      await nativeIdentity(runtimeRoot, "directory", fixtureParent);
      await mkdir(cacheParent);
      await setPrivateOwnerAcl([cacheParent], systemPaths);
      await nativeIdentity(cacheParent, "directory", fixtureParent);
      await mkdir(productionCacheRoot);
      await setPrivateOwnerAcl([productionCacheRoot], systemPaths);
      await nativeIdentity(productionCacheRoot, "directory", fixtureParent);

      // Materialize the fixture as a disposable child of the cache derived from the real path
      // resolver and production-path adapter.
      const root = await mkdtemp(join(productionCacheRoot, "ebb-profile-chain-e2e-"));
      const cacheRoot = root;
      expect(dirname(cacheRoot), "native source cache must be a child of the production cache root").toBe(productionCacheRoot);
      // Git's synthetic source fixture and acceptance marker files are created below this root.
      // Keep the fixture owner-only while allowing that protected ACE to flow to descendants;
      // without inheritance Windows can add a logon-session ACE to Git-created test objects.
      await setPrivateOwnerAcl([cacheRoot], systemPaths, true);
      await nativeIdentity(cacheRoot, "directory", fixtureParent);
      const sourceFixture = await createPinnedGitFixture(root);
      const git = "git.exe";
      let snapshot: Awaited<ReturnType<typeof materializeHermesSourceSnapshot>>;
      let snapshotFailurePhase: HermesSourceSnapshotDiagnosticPhase | undefined;
      try {
        snapshot = await withHermesSourceSnapshotFailureObserver(
          (phase) => { snapshotFailurePhase = phase; },
          () => materializeHermesSourceSnapshot({
            gitExecutable: git, sourceRoot: sourceFixture.sourceRoot, cacheRoot,
            hermesVersion: pinnedHermesVersion, commit: sourceFixture.commit, tree: sourceFixture.tree,
          }),
        );
      } catch (snapshotError) {
        const diagnosticCode = await nativeIdentity(cacheRoot, "directory", fixtureParent)
          .then(() => undefined, (diagnosticError: unknown) => safeNativeDiagnostic(diagnosticError));
        const secondaryIdentity = diagnosticCode ? `;SECONDARY_CACHE_IDENTITY:${diagnosticCode}` : "";
        throw new Error(
          `HERMES_SOURCE_SNAPSHOT_FAILED:${snapshotFailurePhase ?? "UNKNOWN"}${secondaryIdentity}`,
          { cause: snapshotError },
        );
      }
      const { projection } = await ensureHermesSourceSnapshotNativeProjection({ cacheRoot, cacheKey: snapshot.cacheKey });
      const runId = randomUUID();
      const authRoot = join(root, "hermes-root");
      const profile = join(authRoot, "profiles", `ebb-orchestrator-run-${runId}`);
      const home = join(profile, "home");
      const config = join(profile, "config.yaml");
      await mkdir(home, { recursive: true });
      await writeFile(config, "provider-free native path acceptance\n");
      await setPrivateOwnerAcl([authRoot, join(authRoot, "profiles"), profile, home, config], systemPaths);
      const python = await resolvePython();
      const shim = join(root, "hermes.exe");
      await writeFile(shim, "synthetic launcher identity; never executed\n");
      const pythonIdentity = await nativeIdentity(python, "file");
      const hermesIdentity = await nativeIdentity(shim, "file", fixtureParent);
      const profileIdentity = await nativeIdentity(profile, "directory", fixtureParent);
      const targetIdentities = {
        home: await nativeIdentity(home, "directory", fixtureParent),
        config: await nativeIdentity(config, "file", fixtureParent),
      };
      const profileHomePathChain = await verifyHermesProfileHomePathChain(profile, authRoot);
      if (profileIdentity.platform !== "win32") throw new Error("PROFILE_PATH_CHAIN_WINDOWS_IDENTITY_REQUIRED");
      expect(profileHomePathChain?.components.at(-1), "captured chain leaf must equal the separately captured Run-profile identity")
        .toEqual({ volumeSerial: profileIdentity.volumeSerial, fileId: profileIdentity.fileId });
      const snapshotIdentity = await nativeIdentity(snapshot.rootPath, "directory", fixtureParent);
      const environment = {
        HERMES_HOME: profile,
        HOME: home,
        HERMES_CONFIG: config,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        SYSTEMROOT: systemPaths.systemRoot,
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      };
      return {
        root, runId, authRoot, strictBoundary: fixtureParent, managedHome, profile, home, config, python, shim, snapshot, projection, systemPaths,
        pythonIdentity, hermesIdentity, profileIdentity, targetIdentities, profileHomePathChain,
        snapshotIdentity, environment,
      };
    } finally {
      if (previousHomeOverride === undefined) delete process.env.EBB_ORCHESTRATOR_HOME;
      else process.env.EBB_ORCHESTRATOR_HOME = previousHomeOverride;
    }
  }

  async function makeTicket(fixture: Awaited<ReturnType<typeof makeFixture>>, args: string[]) {
    if (!fixture.profileHomePathChain) throw new Error("PROFILE_PATH_CHAIN_CAPTURE_REQUIRED");
    const projectionBytes = await readFile(fixture.projection.path);
    const ticketInput = {
      runId: fixture.runId, attempt: 1, platform: "win32",
      hermesExecutablePath: fixture.shim, hermesExecutableIdentity: fixture.hermesIdentity,
      executablePath: fixture.python, executableIdentity: fixture.pythonIdentity, executableArgsPrefix: args,
      profileHome: fixture.profile, profileHomeIdentity: fixture.profileIdentity,
      profileHomeTargetIdentities: fixture.targetIdentities,
      profileHomePathChain: fixture.profileHomePathChain,
      hermesSourceSnapshotKey: fixture.snapshot.cacheKey,
      hermesSourceSnapshotRoot: fixture.snapshot.rootPath, hermesSourceSnapshotRootIdentity: fixture.snapshotIdentity,
      hermesSourceManifestDigest: fixture.snapshot.manifestDigest,
      hermesSourceProjectionPath: fixture.projection.path,
      hermesSourceProjectionSha256: createHashHex(projectionBytes), hermesSourceProjectionSize: projectionBytes.byteLength,
      environment: { HERMES_HOME: fixture.profile, HOME: fixture.home, HERMES_CONFIG: fixture.config },
    } as const;
    const issued = createHermesLaunchTicket(ticketInput);
    const consumed = consumeHermesLaunchTicket(issued, {
      runId: fixture.runId, attempt: 1, executable: fixture.python, args, environment: fixture.environment,
    });
    expect(consumed.profileHomePathChain, "the one-use launch ticket must preserve every captured component identity")
      .toEqual(fixture.profileHomePathChain);
    expect(consumed.profileHomeIdentity).toEqual(fixture.profileIdentity);
    expect(consumed.profileHomeTargetIdentities).toEqual(fixture.targetIdentities);
    // Reissue the verified copy so the real WindowsJobSupervisor still consumes its own one-use
    // ticket and serializes the exact values which the assertion just read back.
    return createHermesLaunchTicket(consumed);
  }

  async function requireScopesStopped(identities: readonly ProcessScopeIdentity[]): Promise<void> {
    for (const identity of identities) {
      const observation = await supervisor.waitForStopped(identity, 30_000);
      if (observation.state !== "STOPPED") {
        throw new Error("PROFILE_PATH_CHAIN_MUTATION_CLEANUP_STOP_UNPROVEN", { cause: observation });
      }
    }
  }
});

async function nativeIdentity(
  path: string,
  kind: "file" | "directory",
  strictRoot?: string,
  identityPoint: "leaf" | "strict-root" = "leaf",
): Promise<HermesLaunchObjectIdentity> {
  const args = strictRoot
    ? kind === "directory"
      ? ["verify-safe-path-chain", "directory", path, strictRoot]
      : ["verify-safe-file-chain", path, strictRoot]
    : ["verify-safe-path", kind, path];
  try {
    const invocation = await createWindowsNativeHelperInvocation(profileHelper, "hermesProfilePath", args);
    const result = await new ProcessExecutor().exec(invocation.file, [...invocation.args], {
      cwd: tmpdir(), env: { ...invocation.env }, timeout: 10_000, maxBuffer: 16 * 1024,
    });
    if (result.exitCode !== 0 || result.stderr !== "") {
      throw new Error(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
        invocation.file, result.exitCode, result.stdout, result.stderr,
      )));
    }
    const parsed = JSON.parse(result.stdout.trim()) as {
      status?: string;
      kind?: string;
      volumeSerial?: string;
      fileId?: string;
      profileHomePathChain?: {
        authRootIndex?: number;
        components?: Array<{ volumeSerial?: string; fileId?: string }>;
      };
    };
    const chain = parsed.profileHomePathChain;
    const identity = strictRoot && kind === "directory"
      ? identityPoint === "strict-root"
        ? Number.isSafeInteger(chain?.authRootIndex) ? chain?.components?.[chain.authRootIndex!] : undefined
        : chain?.components?.at(-1)
      : parsed;
    const expectedStatus = strictRoot ? kind === "file" ? "SAFE_PATH_FILE_CHAIN" : "SAFE_PATH_CHAIN" : "SAFE_PATH";
    if (parsed.status !== expectedStatus || (!strictRoot && parsed.kind !== kind) ||
        !identity?.volumeSerial || !identity.fileId ||
        !/^[a-f0-9]{16}$/u.test(identity.volumeSerial) || !/^[a-f0-9]{32}$/u.test(identity.fileId)) {
      throw new Error("PROFILE_PATH_CHAIN_NATIVE_IDENTITY_INVALID");
    }
    return { platform: "win32", volumeSerial: identity.volumeSerial, fileId: identity.fileId };
  } catch (error) {
    if (error instanceof Error && (/^(?:VERIFIED_HELPER_LAUNCHER_REJECTED|SECONDARY_PATH_ROOT_ACL_UNSAFE|SECONDARY_PATH_IDENTITY_UNAVAILABLE|PROFILE_PATH_CHAIN_NATIVE_IDENTITY_INVALID)$/u.test(error.message) ||
        /^SECONDARY_PATH_IDENTITY_UNAVAILABLE:(?:ROOT|COMPONENT_INDEX_(?:[1-9]|[1-5][0-9]|6[0-4])|SERIALIZATION_LIMIT)$/u.test(error.message) ||
        isSafeHermesPathComponentAclDiagnostic(error.message))) {
      throw error;
    }
    const diagnostic = safeNativeDiagnostic(error);
    // ExitCodeError contains the full PowerShell invocation (including its encoded command).
    // Preserve only a fixed safe failure as the cause; never expose the original command.
    const sanitizedError = new Error(diagnostic, { cause: new Error("NATIVE_HELPER_FAILURE") });
    throw sanitizedError;
  }
}

async function removeWindowsFixtureTree(path: string, identity: HermesLaunchObjectIdentity): Promise<void> {
  if (identity.platform !== "win32") throw new Error("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_IDENTITY_UNPROVEN");
  const args = ["fixture-tree-remove", path, identity.volumeSerial, identity.fileId];
  try {
    const invocation = await createWindowsNativeHelperInvocation(profileHelper, "hermesProfilePath", args);
    const result = await new ProcessExecutor().exec(invocation.file, [...invocation.args], {
      cwd: tmpdir(), env: { ...invocation.env }, timeout: 30_000, maxBuffer: 8 * 1024,
    });
    if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
      throw new Error(`PROFILE_PATH_CHAIN_FIXTURE_NATIVE_CLEANUP_FAILED:${safeFixtureCleanupResult(result)}`);
    }
  } catch (error) {
    if (error instanceof Error && /^PROFILE_PATH_CHAIN_FIXTURE_NATIVE_CLEANUP_FAILED:[A-Z0-9_]+$/u.test(error.message)) throw error;
    if (error instanceof ExitCodeError) {
      throw new Error(`PROFILE_PATH_CHAIN_FIXTURE_NATIVE_CLEANUP_FAILED:${safeFixtureCleanupExitCode(error.exitCode)}`, { cause: error });
    }
    throw new Error("PROFILE_PATH_CHAIN_FIXTURE_NATIVE_CLEANUP_FAILED", { cause: error });
  }
}

function safeFixtureCleanupExitCode(exitCode: number): string {
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) return "EXIT_CODE_INVALID";
  if (exitCode === 126) return "HELPER_GATE_FAILED";
  if (exitCode === 127) return "HELPER_INTEGRITY_FAILED";
  return `NATIVE_EXIT_${exitCode}`;
}

function safeFixtureCleanupResult(result: { exitCode: number; stdout: string; stderr: string }): string {
  const exitCode = safeFixtureCleanupExitCode(result.exitCode);
  if (exitCode === "EXIT_CODE_INVALID") return exitCode;
  if (exitCode !== `NATIVE_EXIT_${result.exitCode}`) return exitCode;
  if (result.stdout !== "" || result.stderr !== "") return "UNEXPECTED_HELPER_OUTPUT";
  return exitCode;
}

async function resolvePython(): Promise<string> {
  for (const command of ["python", "py"]) {
    try {
      const result = await new ProcessExecutor().exec(command, command === "py" ? ["-3", "-c", "import sys;print(sys.executable)"] : ["-c", "import sys;print(sys.executable)"], {
        cwd: tmpdir(), env: processEnvironment(), timeout: 5_000, maxBuffer: 4096,
      });
      if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
    } catch { /* Try the next supported Windows launcher. */ }
  }
  throw new Error("PROFILE_PATH_CHAIN_ACCEPTANCE_PYTHON_UNAVAILABLE");
}

function ownerIdentity(owner: ReturnType<typeof prepareRunProcessOwner>) {
  const identity: ProcessScopeIdentity = {
    runId: owner.runId, containmentKind: owner.containmentKind, containmentId: owner.containmentId,
    launchNonce: owner.launchNonce, systemdInvocationId: null, systemdControlGroup: null,
    supervisorPid: null, supervisorStartIdentity: null, pid: null, platform: null,
    processStartIdentity: null, executableIdentity: null, state: "PREPARED",
  };
  return identity;
}

async function setPrivateOwnerAcl(
  paths: string[], systemPaths: VerifiedWindowsSystemPaths, inheritChildren = false,
): Promise<void> {
  for (const path of paths) {
    const command = [
      "$ErrorActionPreference='Stop';",
      "$path=[Environment]::GetEnvironmentVariable('EBB_PROFILE_FIXTURE_PATH');",
      "$inheritChildren=[Environment]::GetEnvironmentVariable('EBB_PROFILE_FIXTURE_INHERIT_CHILDREN') -eq '1';",
      "$inheritance=[Security.AccessControl.InheritanceFlags]::None; if ($inheritChildren) { $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit };",
      "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
      "$acl=Get-Acl -LiteralPath $path; $acl.SetAccessRuleProtection($true,$false);",
      "foreach($entry in @($acl.Access)){ $acl.RemoveAccessRuleAll($entry) };",
      "$acl.SetOwner($identity);",
      "$rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);",
      "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;",
      "$verified=Get-Acl -LiteralPath $path; $rules=@($verified.Access);",
      "if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rules[0].FileSystemRights -ne 0x001F01FF -or $rules[0].InheritanceFlags -ne $inheritance -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rules[0].IsInherited) { throw 'FIXTURE_DACL_VERIFICATION_FAILED' };",
    ].join(" ");
    execFileSync(systemPaths.powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
      env: fixtureCommandEnvironment(systemPaths, {
        EBB_PROFILE_FIXTURE_PATH: path,
        EBB_PROFILE_FIXTURE_INHERIT_CHILDREN: inheritChildren ? "1" : "0",
      }),
    });
  }
}

async function createPrivateOwnerFixtureDirectory(path: string, systemPaths: VerifiedWindowsSystemPaths): Promise<void> {
  const command = [
    "$ErrorActionPreference='Stop';",
    "$path=[Environment]::GetEnvironmentVariable('EBB_PROFILE_FIXTURE_PATH');",
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "if ([IO.Directory]::Exists($path)) { throw 'FIXTURE_PATH_ALREADY_EXISTS' };",
    "$acl=New-Object Security.AccessControl.DirectorySecurity;",
    "$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($identity);",
    "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "$directory=[IO.DirectoryInfo]::new($path); $directory.Create($acl);",
    "$verified=$directory.GetAccessControl();",
    "if (-not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'FIXTURE_DACL_VERIFICATION_FAILED' };",
    "$rules=@($verified.Access);",
    "if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rules[0].FileSystemRights -ne 0x001F01FF -or $rules[0].InheritanceFlags -ne $inherit -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rules[0].IsInherited) { throw 'FIXTURE_DACL_VERIFICATION_FAILED' };",
  ].join(" ");
  execFileSync(systemPaths.powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4096,
    env: fixtureCommandEnvironment(systemPaths, { EBB_PROFILE_FIXTURE_PATH: path }),
  });
}

async function addForeignWriteAce(path: string, systemPaths: VerifiedWindowsSystemPaths): Promise<void> {
  runFixtureIccacls(path, "grant-foreign-write", systemPaths);
}

async function removeForeignWriteAce(path: string, systemPaths: VerifiedWindowsSystemPaths): Promise<void> {
  // The fixture was initialized with a protected owner-only DACL. Remove only the one
  // explicit Everyone grant this test may have added; do not touch owner, inheritance, or ACLs above.
  runFixtureIccacls(path, "remove-foreign-grants", systemPaths);
}

type FixtureIccaclsOperation = "grant-foreign-write" | "remove-foreign-grants";

function buildFixtureIccaclsInvocation(path: string, operation: FixtureIccaclsOperation, system32: string): { executable: string; args: string[] } {
  const executable = join(system32, "icacls.exe");
  const args = operation === "grant-foreign-write"
    ? [path, "/grant", "*S-1-1-0:(WD)"]
    : [path, "/remove:g", "*S-1-1-0"];
  return { executable, args };
}

function runFixtureIccacls(path: string, operation: FixtureIccaclsOperation, systemPaths: VerifiedWindowsSystemPaths): void {
  const invocation = buildFixtureIccaclsInvocation(path, operation, systemPaths.system32);
  execFileSync(invocation.executable, invocation.args, {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4_096,
    env: fixtureCommandEnvironment(systemPaths),
  });
}

async function renameDenied(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    await rename(destination, source);
    return false;
  } catch (error) {
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES") || isErrno(error, "EBUSY")) return true;
    throw error;
  }
}

async function attemptLiveAncestorJunction(
  source: string,
  moved: string,
  target: string,
  systemPaths: VerifiedWindowsSystemPaths,
): Promise<"RENAME_DENIED" | "JUNCTION_INSTALLED"> {
  try {
    await rename(source, moved);
  } catch (error) {
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES") || isErrno(error, "EBUSY")) return "RENAME_DENIED";
    throw error;
  }
  await createDirectoryJunction(source, target, systemPaths);
  return "JUNCTION_INSTALLED";
}

async function createDirectoryJunction(path: string, target: string, systemPaths: VerifiedWindowsSystemPaths): Promise<void> {
  const command = [
    "$ErrorActionPreference='Stop';",
    "$path=[Environment]::GetEnvironmentVariable('EBB_PROFILE_FIXTURE_PATH');",
    "$target=[Environment]::GetEnvironmentVariable('EBB_PROFILE_FIXTURE_TARGET');",
    "New-Item -ItemType Junction -Path $path -Target $target | Out-Null;",
  ].join(" ");
  execFileSync(systemPaths.powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    shell: false, windowsHide: true,
    timeout: 10_000,
    maxBuffer: 4_096,
    env: {
      ...fixtureCommandEnvironment(systemPaths),
      EBB_PROFILE_FIXTURE_PATH: path,
      EBB_PROFILE_FIXTURE_TARGET: target,
    },
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)); }
  }
  throw new Error("PROFILE_PATH_CHAIN_ACCEPTANCE_MARKER_TIMEOUT");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function createHashHex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedPathChainEvidenceDigest(
  stage: (typeof WINDOWS_PATH_CHAIN_EVIDENCE_STAGES)[number],
  runId: string,
  chain: { readonly version: number; readonly components: readonly { readonly volumeSerial: string; readonly fileId: string }[] } | undefined,
  targets: { readonly home: HermesLaunchObjectIdentity; readonly config: HermesLaunchObjectIdentity },
): string {
  if (!chain || targets.home.platform !== "win32" || targets.config.platform !== "win32") {
    throw new Error("PROFILE_PATH_CHAIN_EVIDENCE_EXPECTATION_INVALID");
  }
  const lines = [
    "EBB-PATH-CHAIN-EVIDENCE-V1",
    stage,
    runId,
    `chain-v${chain.version}`,
    `component-count=${chain.components.length}`,
    ...chain.components.map((component) => `${component.volumeSerial}:${component.fileId}`),
    `home:${targets.home.volumeSerial}:${targets.home.fileId}`,
    `config:${targets.config.volumeSerial}:${targets.config.fileId}`,
  ];
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function existingRealDirectory(directory: string): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("PROFILE_PATH_CHAIN_FIXTURE_PARENT_NOT_REAL_DIRECTORY");
  }
  return true;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameNativeIdentity(left: HermesLaunchObjectIdentity, right: HermesLaunchObjectIdentity): boolean {
  return left.platform === "win32" && right.platform === "win32" &&
    left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function safeNativeDiagnostic(error: unknown): string {
  if (error instanceof ExitCodeError) return sanitizeHermesPathIdentityDiagnostic(error);
  const message = error instanceof Error ? error.message : "";
  return (/^(?:VERIFIED_HELPER_LAUNCHER_REJECTED|SECONDARY_PATH_ROOT_ACL_UNSAFE|SECONDARY_PATH_IDENTITY_UNAVAILABLE)$/u.test(message) ||
      /^SECONDARY_PATH_IDENTITY_UNAVAILABLE:(?:ROOT|COMPONENT_INDEX_(?:[1-9]|[1-5][0-9]|6[0-4])|SERIALIZATION_LIMIT)$/u.test(message) ||
      isSafeHermesPathComponentAclDiagnostic(message))
    ? message
    : "SECONDARY_PATH_IDENTITY_UNAVAILABLE";
}

describe("Hermes profile-chain fixture ACL command construction", () => {
  it("derives the OS root and tools only from the verified native PowerShell identity", () => {
    const identity = JSON.stringify({
      status: "SAFE_PATH",
      kind: "file",
      path: "\\\\?\\D:\\CustomWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      volumeSerial: "0123456789abcdef",
      fileId: "0123456789abcdef0123456789abcdef",
    });
    expect(parseVerifiedWindowsSystemPowerShellIdentity(`${identity}\r\n`)).toEqual({
      powershell: "D:\\CustomWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      system32: "D:\\CustomWindows\\System32",
      systemRoot: "D:\\CustomWindows",
      volumeRoot: "D:\\",
    });
  });

  it.each([
    ["extra identity property", { extra: true }],
    ["unsafe status", { status: "UNKNOWN" }],
    ["wrong object kind", { kind: "directory" }],
    ["malformed volume id", { volumeSerial: "xyz" }],
    ["malformed file id", { fileId: "xyz" }],
    ["caller-shaped path", { path: "relative\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }],
    ["wrong executable suffix", { path: "D:\\Other\\powershell.exe" }],
  ])("fails closed on %s in the native PowerShell identity", (_label, override) => {
    const identity = {
      status: "SAFE_PATH",
      kind: "file",
      path: "\\\\?\\D:\\CustomWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      volumeSerial: "0123456789abcdef",
      fileId: "0123456789abcdef0123456789abcdef",
      ...override,
    };
    expect(() => parseVerifiedWindowsSystemPowerShellIdentity(JSON.stringify(identity))).toThrow(
      "PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID",
    );
  });

  it("targets one exact profile path with a DACL-only Everyone grant and matching cleanup", () => {
    const target = "C:\\fixture root\\profiles\\run profile";
    const system32 = "C:\\Windows\\System32";
    const grant = buildFixtureIccaclsInvocation(target, "grant-foreign-write", system32);
    const cleanup = buildFixtureIccaclsInvocation(target, "remove-foreign-grants", system32);

    expect(grant.args).toEqual([target, "/grant", "*S-1-1-0:(WD)"]);
    expect(cleanup.args).toEqual([target, "/remove:g", "*S-1-1-0"]);
    expect(grant.executable).toMatch(/[\\/]system32[\\/]icacls\.exe$/iu);
    expect(cleanup.executable).toBe(grant.executable);
    expect([...grant.args, ...cleanup.args]).not.toContain("/T");
    expect([...grant.args, ...cleanup.args]).not.toContain("/inheritance:r");
    expect([...grant.args, ...cleanup.args].some((argument) => /\(OI\)|\(CI\)/u.test(argument))).toBe(false);
  });
});

async function getVerifiedWindowsSystemPaths(): Promise<VerifiedWindowsSystemPaths> {
  if (verifiedWindowsSystemPaths) return verifiedWindowsSystemPaths;
  try {
    // Verify the package-built native artifact from its generated parent-code digest, then invoke
    // its OS API probe directly so caller SystemRoot cannot select the bootstrap PowerShell.
    await verifyNativeHelperIntegrity(profileHelper, "hermesProfilePath");
  } catch {
    throw new Error("PROFILE_PATH_CHAIN_NATIVE_HELPER_INTEGRITY_UNAVAILABLE");
  }
  const result = spawnSync(profileHelper, ["verify-windows-system-powershell"], {
      cwd: repo,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8_192,
    });
  if (result.error || result.signal || result.status !== 0 || result.stderr !== "" ||
      typeof result.stdout !== "string" || result.stdout.length > 8_192) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_VERIFICATION_FAILED");
  }
  verifiedWindowsSystemPaths = parseVerifiedWindowsSystemPowerShellIdentity(result.stdout);
  return verifiedWindowsSystemPaths;
}

function parseVerifiedWindowsSystemPowerShellIdentity(stdout: string): VerifiedWindowsSystemPaths {
  if (stdout.length > 8_192) throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  const line = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!line || line.includes("\n") || line.includes("\r")) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(line) as unknown; } catch {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  const identity = parsed as Record<string, unknown>;
  if (Object.keys(identity).sort().join(",") !== "fileId,kind,path,status,volumeSerial" ||
      identity.status !== "SAFE_PATH" || identity.kind !== "file" || typeof identity.path !== "string" ||
      typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId) ||
      typeof identity.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(identity.volumeSerial)) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  const reportedPath = identity.path.startsWith("\\\\?\\") ? identity.path.slice(4) : identity.path;
  const normalizedPath = win32.normalize(reportedPath);
  const volumeRoot = win32.parse(normalizedPath).root;
  if (!win32.isAbsolute(reportedPath) || normalizedPath.toLowerCase() !== reportedPath.toLowerCase() ||
      !/^[A-Za-z]:\\$/u.test(volumeRoot) ||
      !normalizedPath.toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe")) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  const system32 = win32.dirname(win32.dirname(win32.dirname(normalizedPath)));
  const systemRoot = win32.dirname(system32);
  if (win32.parse(system32).root.toLowerCase() !== volumeRoot.toLowerCase() ||
      win32.parse(systemRoot).root.toLowerCase() !== volumeRoot.toLowerCase()) {
    throw new Error("PROFILE_PATH_CHAIN_SYSTEM_POWERSHELL_IDENTITY_INVALID");
  }
  return { powershell: normalizedPath, system32, systemRoot, volumeRoot };
}

function setSystemRootAliases(systemRoot: string): void {
  process.env.SystemRoot = systemRoot;
  process.env.SYSTEMROOT = systemRoot;
}

function restoreSystemRootAliases(): void {
  if (originalSystemRootAliases.SystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRootAliases.SystemRoot;
  if (originalSystemRootAliases.SYSTEMROOT === undefined) delete process.env.SYSTEMROOT;
  else process.env.SYSTEMROOT = originalSystemRootAliases.SYSTEMROOT;
}

function fixtureCommandEnvironment(
  systemPaths: VerifiedWindowsSystemPaths,
  additions: Record<string, string> = {},
): Record<string, string> {
  return {
    SystemRoot: systemPaths.systemRoot,
    SYSTEMROOT: systemPaths.systemRoot,
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...additions,
  };
}
