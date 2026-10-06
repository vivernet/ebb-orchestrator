import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  consumeHermesLaunchTicket,
  createHermesLaunchTicket,
  type HermesLaunchTicketInput,
} from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";

const sourceSnapshotKey = JSON.stringify({
  formatVersion: 1, hermesVersion: "v0.21.5+7357.g9244275", manifestDigest: "c".repeat(64),
  sourceCommit: "b".repeat(40), sourceTree: "d".repeat(40),
});
const sourceSnapshotDirectoryId = createHash("sha256").update(sourceSnapshotKey).digest("hex");
const sourceSnapshotRoot = `C:\\Ebb\\runtime\\hermes\\source-snapshots\\${sourceSnapshotDirectoryId}`;

const input: HermesLaunchTicketInput = {
  runId: "run-1",
  attempt: 2,
  platform: "win32",
  hermesExecutablePath: "C:\\Hermes\\bin\\hermes.exe",
  hermesExecutableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "c".repeat(32) },
  executablePath: "C:\\Hermes\\tools\\runtime\\python.exe",
  executableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) },
  executableArgsPrefix: ["-I", "-B", "-S", "-c", "snapshot-bootstrap"],
  profileHome: "C:\\Hermes\\profiles\\run-1",
  profileHomeIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) },
  hermesSourceSnapshotKey: sourceSnapshotKey,
  hermesSourceSnapshotRoot: sourceSnapshotRoot,
  hermesSourceSnapshotRootIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "e".repeat(32) },
  hermesSourceManifestDigest: "c".repeat(64),
  hermesSourceProjectionPath: `C:\\Ebb\\runtime\\hermes\\source-snapshots\\${sourceSnapshotDirectoryId}.native-v1.bin`,
  hermesSourceProjectionSha256: "f".repeat(64),
  hermesSourceProjectionSize: 128,
  environment: {
    HERMES_HOME: "C:\\Hermes\\profiles\\run-1",
    HOME: "C:\\Hermes\\profiles\\run-1\\home",
    HERMES_CONFIG: "C:\\Hermes\\profiles\\run-1\\config.yaml",
  },
};

describe("Hermes launch ticket", () => {
  it("rejects a missing ticket at the process launch boundary", () => {
    expect(() => consumeHermesLaunchTicket(undefined, {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    })).toThrow("HERMES_LAUNCH_TICKET_REQUIRED");
  });

  it("rejects a request whose Hermes environment differs from the Run-bound ticket", () => {
    const ticket = createHermesLaunchTicket(input);
    expect(() => consumeHermesLaunchTicket(ticket, {
      runId: input.runId,
      attempt: input.attempt,
      executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"],
      environment: { ...input.environment, HERMES_HOME: "C:\\attacker\\profile" },
    })).toThrow("HERMES_LAUNCH_TICKET_MISMATCH");
  });

  it("binds executable, profile identities, Run attempt, and consumes exactly once", () => {
    const ticket = createHermesLaunchTicket(input);
    const request = {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    };
    const identity = consumeHermesLaunchTicket(ticket, request);

    expect(identity.executableIdentity).toEqual(input.executableIdentity);
    expect(identity.hermesExecutableIdentity).toEqual(input.hermesExecutableIdentity);
    expect(identity.profileHomeIdentity).toEqual(input.profileHomeIdentity);
    expect(identity.hermesSourceSnapshotKey).toBe(input.hermesSourceSnapshotKey);
    expect(identity.hermesSourceSnapshotRootIdentity).toEqual(input.hermesSourceSnapshotRootIdentity);
    expect(identity.hermesSourceManifestDigest).toBe(input.hermesSourceManifestDigest);
    expect(identity.hermesSourceProjectionPath).toBe(input.hermesSourceProjectionPath);
    expect(identity.hermesSourceProjectionSha256).toBe(input.hermesSourceProjectionSha256);
    expect(identity.hermesSourceProjectionSize).toBe(input.hermesSourceProjectionSize);
    expect(() => consumeHermesLaunchTicket(ticket, request)).toThrow("HERMES_LAUNCH_TICKET_REUSED");
  });

  it("rejects a ticket presented for another Run attempt", () => {
    const ticket = createHermesLaunchTicket(input);
    expect(() => consumeHermesLaunchTicket(ticket, {
      runId: input.runId, attempt: 3, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    })).toThrow("HERMES_LAUNCH_TICKET_MISMATCH");
  });

  it("does not authorize replacing the pinned bootstrap argument prefix", () => {
    const ticket = createHermesLaunchTicket(input);
    expect(() => consumeHermesLaunchTicket(ticket, {
      runId: input.runId,
      attempt: input.attempt,
      executable: input.executablePath,
      args: ["-I", "-B", "-S", "-c", "untrusted-code", "chat"],
      environment: input.environment,
    })).toThrow("HERMES_LAUNCH_TICKET_MISMATCH");
  });

  it("rejects a source projection path that is not the sidecar for the ticket's exact cache key", () => {
    expect(() => createHermesLaunchTicket({
      ...input,
      hermesSourceProjectionPath: `${input.hermesSourceProjectionPath}.attacker`,
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });

  it("rejects a missing durable Hermes source key", () => {
    expect(() => createHermesLaunchTicket({ ...input, hermesSourceSnapshotKey: "" }))
      .toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });
});
