import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pinnedLinuxLauncherScript, resolveHermesExecutable, verifyHermesProfileHomeIdentity, verifyHermesProfileHomePathChain } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";
import { createHermesLaunchTicket } from "../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../src/modules/runtime/hermes/hermes-provider-selection.js";
import { ensureHermesSourceSnapshotNativeProjection, materializeHermesSourceSnapshot } from "../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { createHermesRunProfileHome, writeHermesRunProfileConfig } from "../../src/platform/home/hermes-profile-home.js";
import { prepareRunProcessOwner } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import { ProcessExecutor, type ProcessResult } from "../../src/platform/process/process-executor.js";
import { runVerifiedNativeHelper } from "../../src/platform/process/native-helper-launcher.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { createPinnedGitFixture } from "../helpers/hermes-source-snapshot-acceptance-fixture.js";

const enabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";
const linux = process.platform === "linux";
const windows = process.platform === "win32";
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helperPath = join(serverRoot, "dist/native/hermes-profile-path", windows ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path");
const launcherPath = join(serverRoot, "dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher");

describe.skipIf(!enabled || !linux)("Linux Hermes host permission compatibility", () => {
  it.each([0o775, 0o777])("resolves and launches through host mode %s while keeping private state strict", async (hostMode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ebb-hermes-host-")));
    let cleanupAllowed = true;
    let failure: unknown;
    const supervisor = new SystemdRunSupervisor(new ProcessExecutor(), { linuxHermesLauncherPath: launcherPath });
    try {
      await chmod(root, hostMode);
      const source = await createPinnedGitFixture(root);
      const cwd = join(root, "cwd");
      const home = join(root, "auth-root");
      const bin = join(source.sourceRoot, ".hermes/bin");
      const runtime = join(root, "runtime");
      const runtimeEntry = join(runtime, "python");
      await Promise.all([mkdir(cwd), mkdir(home), mkdir(bin, { recursive: true }), mkdir(join(runtimeEntry, "bin"), { recursive: true })]);
      for (const directory of [source.sourceRoot, home, bin, runtime, runtimeEntry, join(runtimeEntry, "bin")]) await chmod(directory, hostMode);
      const python = join(runtimeEntry, "bin/python3");
      await copyFile(await realpath("/usr/bin/python3"), python);
      await chmod(python, 0o777);
      const shim = join(bin, "hermes");
      const shellWord = (word: string) => `'${word.replaceAll("'", `'"'"'`)}'`;
      const script = pinnedLinuxLauncherScript(source.sourceRoot);
      await writeFile(shim, `#!/bin/sh\nexec ${[python, "-I", "-c", script].map((word) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : shellWord(word)).join(" ")} "$@"\n`);
      await chmod(shim, 0o777);
      const facts = join(runtime, "facts.json");
      const stamp = join(source.sourceRoot, "install-stamp.json");
      await writeFile(facts, JSON.stringify({ schema: 1, packages: { python: { entry: "python" } } }));
      await writeFile(stamp, JSON.stringify({ baseVersion: "0.21.5", runtimeDir: runtime }));
      await chmod(facts, 0o666);
      await chmod(stamp, 0o666);
      const profiles = join(home, "profiles");
      await mkdir(profiles);
      await chmod(profiles, hostMode);
      const hostConfig = join(home, "config.yaml");
      await writeFile(hostConfig, "model:\n  provider: openai-api\n  default: fixture-model\n");
      await chmod(hostConfig, 0o666);
      const options = {
        cwd, pathValue: bin, platform: "linux" as const,
        environment: { HOME: root, HERMES_HOME: home, HERMES_RUNTIME_DIR: runtime },
        // Только Git pin/signature evidence синтетическое. Filesystem, readers и native helper реальные.
        runCommand: async (_file: string, args: string[]): Promise<ProcessResult> => {
          if (args.includes("--show-toplevel")) return { exitCode: 0, stdout: `${source.sourceRoot}\n`, stderr: "" };
          if (args.includes("HEAD^{tree}")) return { exitCode: 0, stdout: `${source.tree}\n`, stderr: "" };
          if (args.includes("--verify")) return { exitCode: 0, stdout: `${HERMES_PROVIDER_SELECTION_SOURCE.commit}\n`, stderr: "" };
          if (args.includes("diff") || args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
          throw new Error("HOST_FIXTURE_UNEXPECTED_PROBE");
        },
      };
      const resolution = await resolveHermesExecutable(options);
      expect(resolution.hermesConfigHome).toBe(home);
      const runId = randomUUID();
      const plannedProfile = join(profiles, `ebb-orchestrator-run-${runId}`);
      const beforeConfig = await readFile(hostConfig);
      const projection = await runVerifiedNativeHelper(helperPath, "hermesProfilePath", ["project-selection", home, plannedProfile, runId], { timeout: 10_000, maxBuffer: 8192 });
      expect(projection.exitCode).toBe(0);
      expect(JSON.parse(projection.stdout)).toMatchObject({ status: "EXPLICIT_SELECTION", providerId: "openai-api", modelId: "fixture-model" });
      expect(await readFile(hostConfig)).toEqual(beforeConfig);
      for (const pathname of [home, profiles, source.sourceRoot, runtime]) expect((await lstat(pathname)).mode & 0o777).toBe(hostMode);

      // Reader должен отвергать symlink ancestor и leaf до потребления mutable host facts.
      await rename(facts, `${facts}.original`);
      await symlink(`${facts}.original`, facts);
      await expect(resolveHermesExecutable(options)).rejects.toThrow("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
      await rm(facts);
      await rename(`${facts}.original`, facts);
      await rename(runtimeEntry, `${runtimeEntry}-original`);
      await symlink(`${runtimeEntry}-original`, runtimeEntry, "dir");
      await expect(resolveHermesExecutable(options)).rejects.toThrow("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
      await rm(runtimeEntry);
      await rename(`${runtimeEntry}-original`, runtimeEntry);
      const profile = await createHermesRunProfileHome({ hermesRoot: home, runId, helperPath, platform: "linux" });
      await writeHermesRunProfileConfig({ profileHome: profile, runId, helperPath, platform: "linux", configYaml: "model:\n  provider: openai-api\n  default: fixture-model\n" });
      const profileIdentity = await verifyHermesProfileHomeIdentity(profile);
      await chmod(profile, 0o770);
      await expect(verifyHermesProfileHomeIdentity(profile)).rejects.toThrow("HERMES_PATH_UNSAFE");
      await chmod(profile, 0o700);
      const cacheRoot = join(root, "private-cache");
      await mkdir(cacheRoot, { mode: 0o700 });
      const snapshot = await materializeHermesSourceSnapshot({ gitExecutable: "/usr/bin/git", sourceRoot: source.sourceRoot, cacheRoot, hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version, commit: source.commit, tree: source.tree });
      const { projection: nativeProjection, snapshot: accepted } = await ensureHermesSourceSnapshotNativeProjection({ cacheRoot, cacheKey: snapshot.cacheKey });
      const environment = { HERMES_HOME: profile, HOME: join(profile, "home"), HERMES_CONFIG: join(profile, "config.yaml"), PATH: "/usr/bin:/bin" };
      const args = ["-I", "-B", "-S", "-c", `import sys,time;sys.path.insert(0,${JSON.stringify(snapshot.rootPath)});import marker_module;print(marker_module.VALUE,flush=True);time.sleep(2)`];
      const ticket = createHermesLaunchTicket({
        runId, attempt: 1, platform: "linux", hermesExecutablePath: resolution.executablePath,
        hermesExecutableIdentity: resolution.executableIdentity, executablePath: python,
        executableIdentity: resolution.runtimeExecutableIdentity, executableArgsPrefix: args,
        profileHome: profile, profileHomeIdentity: profileIdentity,
        hermesSourceSnapshotKey: accepted.cacheKey, hermesSourceSnapshotRoot: accepted.rootPath,
        hermesSourceSnapshotRootIdentity: await verifyHermesProfileHomeIdentity(accepted.rootPath),
        hermesSourceManifestDigest: accepted.manifestDigest, hermesSourceProjectionPath: nativeProjection.path,
        hermesSourceProjectionSha256: nativeProjection.sha256, hermesSourceProjectionSize: nativeProjection.size, environment,
      });
      const owner = prepareRunProcessOwner(runId, profile, "systemd-user-service", accepted.cacheKey);
      let identity: ProcessScopeIdentity = {
        runId, containmentKind: owner.containmentKind, containmentId: owner.containmentId,
        launchNonce: owner.launchNonce, systemdInvocationId: null, systemdControlGroup: null,
        supervisorPid: null, supervisorStartIdentity: null, pid: null, platform: null,
        processStartIdentity: null, executableIdentity: null, state: "LAUNCHING",
      };
      cleanupAllowed = false;
      try {
        const handle = await supervisor.launch(identity, { executable: python, args, cwd, environment, attempt: 1, hermesLaunchTicket: ticket, timeoutMs: 30_000 }, async (live) => { identity = live; });
        const result = await handle.completion;
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("snapshot-pinned-v1");
      } finally {
        const observation = await supervisor.inspect(identity);
        const stopped = observation.state === "LIVE" ? await supervisor.stop(observation.identity) : observation;
        expect(stopped.state, "exact native scope must be STOPPED before private restoration/cleanup").toBe("STOPPED");
        cleanupAllowed = stopped.state === "STOPPED";
      }
      // Digest/private negatives после fresh STOPPED; fixture restore не служит stop evidence.
      const module = join(snapshot.rootPath, "marker_module.py");
      await chmod(module, 0o600);
      await expect(ensureHermesSourceSnapshotNativeProjection({ cacheRoot, cacheKey: snapshot.cacheKey })).rejects.toThrow("HERMES_SOURCE_SNAPSHOT_UNAVAILABLE");
      await writeFile(module, "VALUE = 'modified'\n");
      await chmod(module, 0o400);
      await expect(ensureHermesSourceSnapshotNativeProjection({ cacheRoot, cacheKey: snapshot.cacheKey })).rejects.toThrow("HERMES_SOURCE_SNAPSHOT_UNAVAILABLE");
    } catch (error) {
      failure = error;
    } finally {
      if (cleanupAllowed) {
        await makeRemovable(root);
        await rm(root, { recursive: true, force: true });
      }
    }
    if (!cleanupAllowed) throw new Error("HOST_FIXTURE_RETAINED_STOP_UNPROVEN");
    if (failure) throw failure;
  }, 120_000);
});

describe.skipIf(!enabled || !windows)("Windows host/private native command boundary", () => {
  it("accepts a disposable host FullControl grant and refuses the same grant on a private leaf", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ebb-hermes-host-")));
    const icacls = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/icacls.exe");
    try {
      execFileSync(icacls, [root, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { shell: false, windowsHide: true, stdio: "pipe" });
      const host = await runVerifiedNativeHelper(helperPath, "hermesProfilePath", ["verify-host-path", "directory", root], { timeout: 10_000, maxBuffer: 8192 });
      expect(JSON.parse(host.stdout)).toMatchObject({ status: "SAFE_PATH", kind: "directory" });
      const runId = randomUUID();
      const profile = await createHermesRunProfileHome({ hermesRoot: root, runId, helperPath, platform: "win32" });
      await verifyHermesProfileHomeIdentity(profile);
      const chain = await verifyHermesProfileHomePathChain(profile, root);
      expect(chain?.version).toBe(2);
      expect(chain?.privateRootIndex).toBe((chain?.authRootIndex ?? -1) + 2);
      expect(chain?.privateRootIndex).toBe((chain?.components.length ?? 0) - 1);
      execFileSync(icacls, [profile, "/grant", "*S-1-1-0:(F)"], { shell: false, windowsHide: true, stdio: "pipe" });
      await expect(verifyHermesProfileHomeIdentity(profile)).rejects.toThrow("HERMES_PATH_UNSAFE");
      // Payload не запускался; удаляется только этот exact new fixture child.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function makeRemovable(root: string): Promise<void> {
  const details = await lstat(root);
  if (details.isSymbolicLink()) throw new Error("HOST_FIXTURE_CLEANUP_SYMLINK");
  if (!details.isDirectory()) return;
  await chmod(root, 0o700);
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root)) await makeRemovable(join(root, entry));
}
