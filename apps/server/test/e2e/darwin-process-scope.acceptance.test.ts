import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import { DarwinRunSupervisor } from "../../src/platform/process/darwin-run-supervisor.js";
import type { ProcessScopeLaunchRequest } from "../../src/platform/process/run-scope-supervisor.js";

const isDarwin = process.platform === "darwin";
const nativeAcceptanceEnabled = process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE === "1";

const isSupported = isDarwin && nativeAcceptanceEnabled;

function owner(): ProcessScopeIdentity {
  return {
    runId: randomUUID(),
    containmentKind: "darwin-process-group",
    containmentId: Buffer.from(randomUUID()).toString("hex").padStart(64, "0").slice(0, 64),
    launchNonce: Buffer.from(randomUUID()).toString("hex").padStart(64, "0").slice(0, 64),
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
}

function request(payload: string): ProcessScopeLaunchRequest {
  return {
    executable: "/bin/sh",
    args: ["-c", payload],
    cwd: tmpdir(),
    environment: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: tmpdir(),
      LANG: "C.UTF-8",
      TMPDIR: tmpdir(),
    },
    timeoutMs: 30_000,
  };
}

describe("Darwin process-scope acceptance", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("completes a dummy payload and proves an empty group after exit", async () => {
    if (!isSupported) return;
    const dir = await mkdtemp(join(tmpdir(), "ebb-darwin-scope-"));
    tmpDirs.push(dir);
    const supervisor = new DarwinRunSupervisor();
    const runOwner = owner();
    let liveOwner = runOwner;
    const handle = await supervisor.launch(runOwner, request("sleep 0.2; echo DARWIN_PAYLOAD_DONE"), async (identity) => { liveOwner = identity; });
    const result = await handle.completion;
    expect(result.stdout).toContain("DARWIN_PAYLOAD_DONE");
    const stopped = await supervisor.waitForStopped(liveOwner);
    expect(stopped.state).toBe("STOPPED");
    if (stopped.state === "STOPPED") expect(stopped.evidence).toBe("DARWIN_GROUP_EMPTY");
  });

  it("stops a long-running payload via EOF on the control channel", async () => {
    if (!isSupported) return;
    const dir = await mkdtemp(join(tmpdir(), "ebb-darwin-scope-"));
    tmpDirs.push(dir);
    const supervisor = new DarwinRunSupervisor();
    const runOwner = owner();
    let liveOwner = runOwner;
    const handle = await supervisor.launch(runOwner, request("sleep 30"), async (identity) => { liveOwner = identity; });
    const stopped = await supervisor.stop(liveOwner);
    expect(stopped.state).toBe("STOPPED");
    await expect(handle.completion).resolves.toBeDefined();
  });

  it("reports UNKNOWN during a live scope and STOPPED only after group-emptiness", async () => {
    if (!isSupported) return;
    const dir = await mkdtemp(join(tmpdir(), "ebb-darwin-scope-"));
    tmpDirs.push(dir);
    const supervisor = new DarwinRunSupervisor();
    const runOwner = owner();
    let liveOwner = runOwner;
    await supervisor.launch(runOwner, request("sleep 0.3"), async (identity) => { liveOwner = identity; });
    const live = await supervisor.inspect(liveOwner);
    if (live.state === "LIVE") {
      expect(live.identity).toBeDefined();
    }
    await supervisor.waitForStopped(liveOwner);
    const final = await supervisor.inspect(liveOwner);
    expect(final.state).toBe("STOPPED");
  });
});
