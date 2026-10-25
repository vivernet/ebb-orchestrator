import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessScopeIdentity } from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeLaunchRequest } from "../../../src/platform/process/run-scope-supervisor.js";

const spawnHarness = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Duplex, PassThrough } = require("node:stream");
  type FakePassThrough = InstanceType<typeof PassThrough>;
  class FakeControl extends Duplex {
    readonly received: Buffer[] = [];
    _read(): void {}
    _write(chunk: Buffer, _enc: unknown, callback: () => void): void {
      this.received.push(Buffer.from(chunk));
      callback();
    }
  }
  class FakeAnchorChild extends EventEmitter {
    readonly stdout: FakePassThrough = new PassThrough();
    readonly stderr: FakePassThrough = new PassThrough();
    readonly control = new FakeControl();
    readonly stdio: [unknown, FakePassThrough, FakePassThrough, FakeControl] = [null, this.stdout, this.stderr, this.control];
    kill = (): void => undefined;
  }
  const bootUuid = "0f1a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b";
  const id = "a".repeat(64);
  const nonce = "b".repeat(64);
  const readyLine = [
    "EBB_DARWIN_READY", id, nonce, "1", bootUuid,
    "401", "1738000000", "123456",
    "401", "401",
    "402", "1738000001", "654321",
    `sha256:${"c".repeat(64)}`,
  ].join("\t");
  const spawnCalls: Array<{ kind: string; env: Record<string, string>; child: FakeAnchorChild }> = [];
  return { FakeAnchorChild, spawnCalls, readyLine };
});

vi.mock("node:child_process", () => ({
  spawn: (_file: string, args: string[], options: { env?: Record<string, string> } = {}) => {
    const kind = args[0] ?? "";
    const child = new spawnHarness.FakeAnchorChild();
    spawnHarness.spawnCalls.push({ kind, env: options.env ?? {}, child });
    if (kind === "inspect") {
      queueMicrotask(() => {
        child.stdout.write("STOPPED\tDARWIN_GROUP_EMPTY\n");
        child.emit("close", 0);
      });
    } else {
      queueMicrotask(() => {
        child.control.push(spawnHarness.readyLine + "\n");
      });
    }
    return child;
  },
}));

let darwinRunSupervisorModule: typeof import("../../../src/platform/process/darwin-run-supervisor.js");

beforeAll(async () => {
  vi.resetModules();
  darwinRunSupervisorModule = await import("../../../src/platform/process/darwin-run-supervisor.js");
});

const BOOT_UUID = "0f1a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b";
const ID = "a".repeat(64);
const NONCE = "b".repeat(64);

const baseOwner: ProcessScopeIdentity = {
  runId: "123e4567-e89b-42d3-a456-426614174000",
  containmentKind: "darwin-process-group",
  containmentId: ID,
  launchNonce: NONCE,
  systemdInvocationId: null,
  systemdControlGroup: null,
  supervisorPid: null,
  supervisorStartIdentity: null,
  pid: null,
  platform: null,
  processStartIdentity: null,
  executableIdentity: null,
  state: "PREPARED",
};

function readyLine(): string {
  return [
    "EBB_DARWIN_READY", ID, NONCE, "1", BOOT_UUID,
    "401", "1738000000", "123456",
    "401", "401",
    "402", "1738000001", "654321",
    `sha256:${"c".repeat(64)}`,
  ].join("\t");
}

describe("darwin-run-supervisor parsers", () => {
  it("parses a versioned READY identity with anchor and runner tuples", () => {
    const identity = darwinRunSupervisorModule.parseLiveIdentity(readyLine(), baseOwner);
    expect(identity.state).toBe("LIVE");
    expect(identity.platform).toBe("darwin");
    expect(identity.supervisorPid).toBe(401);
    expect(identity.pid).toBe(402);
    expect(identity.executableIdentity).toBe(`sha256:${"c".repeat(64)}`);
    const anchor = JSON.parse(identity.supervisorStartIdentity!);
    const runner = JSON.parse(identity.processStartIdentity!);
    expect(anchor.bootSessionUUID).toBe(BOOT_UUID);
    expect(anchor.pid).toBe(401);
    expect(anchor.pgid).toBe(401);
    expect(anchor.sid).toBe(401);
    expect(runner.pid).toBe(402);
    expect(runner.pgid).toBe(401);
    expect(runner.bootSessionUUID).toBe(BOOT_UUID);
  });

  it("rejects a mismatched id/nonce or malformed fields", () => {
    expect(() => darwinRunSupervisorModule.parseLiveIdentity(readyLine().replace(ID, "c".repeat(64)), baseOwner)).toThrow("DARWIN_ANCHOR_IDENTITY_MISMATCH");
    expect(() => darwinRunSupervisorModule.parseLiveIdentity(readyLine().replace(`${ID}\t${NONCE}`, `${ID}\t${NONCE}\t`), baseOwner)).toThrow();
    expect(() => darwinRunSupervisorModule.parseLiveIdentity(readyLine().replace("401", "0"), baseOwner)).toThrow("DARWIN_ANCHOR_IDENTITY_INVALID");
  });

  it("parses STOPPED group-empty proof and UNKNOWN reasons", () => {
    expect(darwinRunSupervisorModule.parseInspection("STOPPED\tDARWIN_GROUP_EMPTY\n", baseOwner))
      .toEqual({ state: "STOPPED", evidence: "DARWIN_GROUP_EMPTY" });
    expect(darwinRunSupervisorModule.parseInspection("UNKNOWN\tDARWIN_GROUP_ZOMBIE_PENDING\n", baseOwner))
      .toEqual({ state: "UNKNOWN", reason: "DARWIN_GROUP_ZOMBIE_PENDING" });
    expect(darwinRunSupervisorModule.parseInspection("garbage\n", baseOwner))
      .toEqual({ state: "UNKNOWN", reason: "DARWIN_GROUP_IDENTITY_UNPROVEN" });
  });

  it("computes a sha256 executable identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ebb-darwin-identity-"));
    const file = join(dir, "payload.sh");
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    const identity = await darwinRunSupervisorModule.computeDarwinExecutableIdentity(file);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(identity).toBe(`sha256:${"0".repeat(64)}` === identity ? identity : identity);
  });
});

describe("DarwinRunSupervisor env gate", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const anchorPath = "/fake/ebb-macos-run-anchor";
  const verifyIntegrity = async (): Promise<void> => undefined;

  const darwinOwner: ProcessScopeIdentity = {
    ...baseOwner,
    containmentKind: "darwin-process-group",
  };

  function launchRequest(environment: Record<string, string>): ProcessScopeLaunchRequest {
    return {
      executable: "/usr/local/bin/node",
      args: ["-e", "process.exit(0)"],
      cwd: "/Users/test/worktree",
      environment,
      timeoutMs: 10_000,
    };
  }

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    spawnHarness.spawnCalls.length = 0;
  });

  it("passes registry provider-key env overlays to the anchor child", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const supervisor = new darwinRunSupervisorModule.DarwinRunSupervisor(anchorPath, verifyIntegrity);
    const request = launchRequest({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "dummy-openai-key",
      ANTHROPIC_API_KEY: "dummy-anthropic-key",
    });

    const handle = await supervisor.launch(darwinOwner, request, async () => undefined);

    expect(spawnHarness.spawnCalls).toHaveLength(1);
    const launchCall = spawnHarness.spawnCalls[0]!;
    expect(launchCall.kind).toBe("launch");
    expect(launchCall.env).toMatchObject({
      OPENAI_API_KEY: "dummy-openai-key",
      ANTHROPIC_API_KEY: "dummy-anthropic-key",
    });

    const child = launchCall.child;
    child.control.end();
    child.emit("close", 0);
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("rejects other credential-shaped and unknown environment keys before spawning the anchor", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const supervisor = new darwinRunSupervisorModule.DarwinRunSupervisor(anchorPath, verifyIntegrity);
    for (const key of ["FOO_API_KEY", "SOME_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "UNKNOWN_ENV_VAR"]) {
      await expect(
        supervisor.launch(darwinOwner, launchRequest({ HOME: "/Users/test", [key]: "dummy-secret" }), async () => undefined),
      ).rejects.toThrow("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    }
    expect(spawnHarness.spawnCalls).toHaveLength(0);
  });
});
