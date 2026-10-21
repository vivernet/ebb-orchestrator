import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessScopeIdentity } from "../../../src/platform/process/process-inspector.js";
import { computeDarwinExecutableIdentity, parseInspection, parseLiveIdentity } from "../../../src/platform/process/darwin-run-supervisor.js";

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
    const identity = parseLiveIdentity(readyLine(), baseOwner);
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
    expect(() => parseLiveIdentity(readyLine().replace(ID, "c".repeat(64)), baseOwner)).toThrow("DARWIN_ANCHOR_IDENTITY_MISMATCH");
    expect(() => parseLiveIdentity(readyLine().replace(`${ID}\t${NONCE}`, `${ID}\t${NONCE}\t`), baseOwner)).toThrow();
    expect(() => parseLiveIdentity(readyLine().replace("401", "0"), baseOwner)).toThrow("DARWIN_ANCHOR_IDENTITY_INVALID");
  });

  it("parses STOPPED group-empty proof and UNKNOWN reasons", () => {
    expect(parseInspection("STOPPED\tDARWIN_GROUP_EMPTY\n", baseOwner))
      .toEqual({ state: "STOPPED", evidence: "DARWIN_GROUP_EMPTY" });
    expect(parseInspection("UNKNOWN\tDARWIN_GROUP_ZOMBIE_PENDING\n", baseOwner))
      .toEqual({ state: "UNKNOWN", reason: "DARWIN_GROUP_ZOMBIE_PENDING" });
    expect(parseInspection("garbage\n", baseOwner))
      .toEqual({ state: "UNKNOWN", reason: "DARWIN_GROUP_IDENTITY_UNPROVEN" });
  });

  it("computes a sha256 executable identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ebb-darwin-identity-"));
    const file = join(dir, "payload.sh");
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    const identity = await computeDarwinExecutableIdentity(file);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(identity).toBe(`sha256:${"0".repeat(64)}` === identity ? identity : identity);
  });
});
