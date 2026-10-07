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
  runId: "123e4567-e89b-42d3-a456-426614174000",
  attempt: 2,
  platform: "win32",
  hermesExecutablePath: "C:\\Hermes\\bin\\hermes.exe",
  hermesExecutableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "c".repeat(32) },
  executablePath: "C:\\Hermes\\tools\\runtime\\python.exe",
  executableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) },
  executableArgsPrefix: ["-I", "-B", "-S", "-c", "snapshot-bootstrap"],
  profileHome: "C:\\Hermes\\profiles\\ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174000",
  profileHomeIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) },
  profileHomeTargetIdentities: {
    home: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "7".repeat(32) },
    config: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "8".repeat(32) },
  },
  profileHomePathChain: {
    version: 1,
    authRootIndex: 1,
    components: [
      { volumeSerial: "0123456789abcdef", fileId: "1".repeat(32) },
      { volumeSerial: "0123456789abcdef", fileId: "2".repeat(32) },
      { volumeSerial: "0123456789abcdef", fileId: "3".repeat(32) },
      { volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) },
    ],
  },
  hermesSourceSnapshotKey: sourceSnapshotKey,
  hermesSourceSnapshotRoot: sourceSnapshotRoot,
  hermesSourceSnapshotRootIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "e".repeat(32) },
  hermesSourceManifestDigest: "c".repeat(64),
  hermesSourceProjectionPath: `C:\\Ebb\\runtime\\hermes\\source-snapshots\\${sourceSnapshotDirectoryId}.native-v1.bin`,
  hermesSourceProjectionSha256: "f".repeat(64),
  hermesSourceProjectionSize: 128,
  environment: {
    HERMES_HOME: "C:\\Hermes\\profiles\\ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174000",
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
    expect(identity.profileHomeTargetIdentities).toEqual(input.profileHomeTargetIdentities);
    expect(identity.hermesSourceSnapshotKey).toBe(input.hermesSourceSnapshotKey);
    expect(identity.hermesSourceSnapshotRootIdentity).toEqual(input.hermesSourceSnapshotRootIdentity);
    expect(identity.hermesSourceManifestDigest).toBe(input.hermesSourceManifestDigest);
    expect(identity.hermesSourceProjectionPath).toBe(input.hermesSourceProjectionPath);
    expect(identity.hermesSourceProjectionSha256).toBe(input.hermesSourceProjectionSha256);
    expect(identity.hermesSourceProjectionSize).toBe(input.hermesSourceProjectionSize);
    expect(() => consumeHermesLaunchTicket(ticket, request)).toThrow("HERMES_LAUNCH_TICKET_REUSED");
  });

  it("requires exact native identities for both Windows profile targets", () => {
    const { profileHomeTargetIdentities: _targetIdentities, ...withoutTargets } = input;
    expect(() => createHermesLaunchTicket(withoutTargets))
      .toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
    expect(() => createHermesLaunchTicket({
      ...input,
      profileHomeTargetIdentities: {
        ...input.profileHomeTargetIdentities!,
        config: { platform: "linux", device: "1", inode: "2" },
      },
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
    expect(() => createHermesLaunchTicket({
      ...input,
      profileHomeTargetIdentities: {
        ...input.profileHomeTargetIdentities!,
        home: { platform: "win32", volumeSerial: "f".repeat(16), fileId: "7".repeat(32) },
      },
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
    expect(() => createHermesLaunchTicket({
      ...input,
      profileHomeTargetIdentities: {
        home: input.profileHomeTargetIdentities!.home,
        config: input.profileHomeTargetIdentities!.home,
      },
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });

  it("binds the complete Windows profile ancestor identity chain to the one-use ticket", () => {
    const profileHomePathChain = {
      ...input.profileHomePathChain!,
      components: [...input.profileHomePathChain!.components],
    };
    const chainInput = { ...input, profileHomePathChain };
    const ticket = createHermesLaunchTicket(chainInput);
    profileHomePathChain.components[1] = { volumeSerial: "0123456789abcdef", fileId: "f".repeat(32) };

    const identity = consumeHermesLaunchTicket(ticket, {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    });

    expect(identity).toHaveProperty("profileHomePathChain");
    expect(identity.profileHomePathChain).toEqual(input.profileHomePathChain);
  });

  it("rejects a chain whose canonical profile path is not bound to the Run ID", () => {
    expect(() => createHermesLaunchTicket({
      ...input,
      profileHome: "C:\\Hermes\\profiles\\ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174001",
      environment: {
        ...input.environment,
        HERMES_HOME: "C:\\Hermes\\profiles\\ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174001",
      },
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });

  it("rejects a chain that marks the auth root as an add-child ancestor", () => {
    expect(() => createHermesLaunchTicket({
      ...input,
      profileHomePathChain: { ...input.profileHomePathChain!, authRootIndex: 2 },
    })).toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
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
