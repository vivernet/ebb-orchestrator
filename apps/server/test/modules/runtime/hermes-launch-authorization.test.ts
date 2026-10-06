import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import * as path from "node:path";
import type { AgentRuntimeRun } from "../../../src/modules/runtime/agent-runtime.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-provider-selection.js";
import {
  type HermesLaunchObjectIdentity,
  type HermesLaunchTicket,
} from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { prepareRunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import type { RunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";

describe("production Hermes launch authorization", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-source-snapshot.js");
    vi.resetModules();
  });

  it("returns a one-use ticket only after the source snapshot is revalidated for native dispatch", async () => {
    const platform = process.platform === "win32" ? "win32" : "linux";
    const paths = platform === "win32" ? path.win32 : path.posix;
    const root = await import("node:os").then(({ tmpdir }) => tmpdir());
    const runId = randomUUID();
    const hermesRoot = paths.join(root, `hermes-${runId}`);
    const profileHome = paths.join(hermesRoot, "profiles", `ebb-orchestrator-run-${runId}`);
    const cacheRoot = paths.join(root, `source-cache-${runId}`);
    const manifestDigest = "a".repeat(64);
    const sourceTree = "b".repeat(40);
    const snapshotKey = JSON.stringify({
      formatVersion: 1,
      hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      manifestDigest,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceTree,
    });
    const snapshotDirectory = createHash("sha256").update(snapshotKey, "utf8").digest("hex");
    const snapshotRoot = paths.join(cacheRoot, snapshotDirectory);
    const projectionPath = `${snapshotRoot}.native-v1.bin`;
    const objectIdentity: HermesLaunchObjectIdentity = platform === "win32"
      ? { platform, volumeSerial: "0000000000000001", fileId: "00000000000000020000000000000003" }
      : { platform, device: "1", inode: "2" };
    const sourceSnapshot = { cacheKey: snapshotKey, manifestDigest, rootPath: snapshotRoot };

    // Server Vitest runs with isolate:false. Another suite may already have cached the
    // adapter with its production resolver binding, so reset before installing these module mocks.
    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-source-snapshot.js");
    vi.resetModules();
    vi.doMock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js", () => ({
      resolveHermesExecutable: vi.fn(async () => ({
        executablePath: paths.join(root, platform === "win32" ? "hermes.exe" : "hermes"),
        executableIdentity: objectIdentity,
        runtimeExecutablePath: paths.join(root, platform === "win32" ? "python.exe" : "python3"),
        runtimeExecutableIdentity: objectIdentity,
        runtimeDependencyRoot: root,
        runtimeArgsPrefix: [],
        hermesProjectRoot: paths.join(root, "hermes-agent"),
        hermesConfigHome: hermesRoot,
        sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
        sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
        sourceTree,
        gitExecutable: paths.join(root, platform === "win32" ? "git.exe" : "git"),
      })),
      buildHermesSnapshotRuntimeArgs: vi.fn(() => ["-I", "-B", "-S", "-c", "pass"]),
      verifyHermesProfileHomeIdentity: vi.fn(async () => objectIdentity),
    }));
    vi.doMock("../../../src/modules/runtime/hermes/hermes-source-snapshot.js", () => ({
      ensureHermesSourceSnapshotNativeProjection: vi.fn(async () => ({
        snapshot: sourceSnapshot,
        projection: { path: projectionPath, sha256: "c".repeat(64), size: 128 },
      })),
      isVerifiedHermesSourceSnapshot: vi.fn(() => true),
    }));

    const { HermesRuntimeAdapter } = await import("../../../src/modules/runtime/hermes/hermes-runtime-adapter.js");
    const { consumeHermesLaunchTicket } = await import("../../../src/modules/runtime/hermes/hermes-launch-ticket.js");
    const adapter = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, { hermesSourceSnapshotCacheRoot: cacheRoot });
    const owner = prepareRunProcessOwner(runId, profileHome, platform === "win32" ? "windows-job" : "systemd-user-service", snapshotKey);
    (adapter as unknown as { loadProcessOwner: (_runId: string, _profile: string) => RunProcessOwner }).loadProcessOwner = () => owner;

    const selection = {
      runId,
      providerId: "openai-api",
      modelId: "selected-model",
      endpointIdentity: "hermes-provider:openai-api",
      endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey: snapshotKey,
      profileHome,
    } as const;
    const run = {
      id: runId,
      role: "developer",
      runtime: "hermes",
      model: selection.modelId,
      taskId: "task-launch-auth",
      epicId: null,
      status: "STARTED",
      sessionId: null,
      attempt: 1,
      triggerReason: "custom",
      contextVersion: "v1",
      outputSchemaVersion: "1",
      startedAt: new Date(),
      endedAt: null,
      exitCode: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      cost: null,
      hermesSelection: selection,
    } satisfies AgentRuntimeRun;

    const authorize = (adapter as unknown as {
      createLaunchAuthorization: (
        run: AgentRuntimeRun,
        cwd: string,
        profile: string,
        environment: { HERMES_HOME: string; HOME: string; HERMES_CONFIG: string },
      ) => Promise<{ executablePath: string; argsPrefix: readonly string[]; ticket: HermesLaunchTicket }>;
    }).createLaunchAuthorization.bind(adapter);

    const prepared = await authorize(run, root, profileHome, {
      HERMES_HOME: profileHome,
      HOME: paths.join(profileHome, "home"),
      HERMES_CONFIG: paths.join(profileHome, "config.yaml"),
    });
    expect(prepared).toMatchObject({
      executablePath: paths.join(root, platform === "win32" ? "python.exe" : "python3"),
      argsPrefix: ["-I", "-B", "-S", "-c", "pass"],
    });
    const authorized = consumeHermesLaunchTicket(prepared.ticket, {
      runId,
      attempt: 1,
      executable: prepared.executablePath,
      args: [...prepared.argsPrefix, "runpy.run_module('hermes_cli.main')"],
      environment: {
        HERMES_HOME: profileHome,
        HOME: paths.join(profileHome, "home"),
        HERMES_CONFIG: paths.join(profileHome, "config.yaml"),
      },
    });
    expect(authorized).toMatchObject({
      runId,
      attempt: 1,
      platform,
      profileHome,
      hermesSourceSnapshotKey: snapshotKey,
      hermesSourceSnapshotRoot: snapshotRoot,
      hermesSourceSnapshotRootIdentity: objectIdentity,
      hermesSourceManifestDigest: manifestDigest,
      hermesSourceProjectionPath: projectionPath,
      hermesSourceProjectionSha256: "c".repeat(64),
      hermesSourceProjectionSize: 128,
      environment: {
        HERMES_HOME: profileHome,
        HOME: paths.join(profileHome, "home"),
        HERMES_CONFIG: paths.join(profileHome, "config.yaml"),
      },
    });
  });
});
