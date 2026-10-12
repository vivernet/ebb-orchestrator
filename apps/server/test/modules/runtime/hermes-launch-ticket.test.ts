import { describe, expect, it } from "vitest";
import {
  consumeHermesLaunchTicket,
  createHermesLaunchTicket,
  type HermesLaunchTicketInput,
} from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-source-identity.js";

const input: HermesLaunchTicketInput = {
  runId: "123e4567-e89b-42d3-a456-426614174000",
  attempt: 1,
  platform: "win32",
  hermesExecutablePath: "C:\\Hermes\\bin\\hermes.cmd",
  hermesExecutableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "c".repeat(32) },
  sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
  executablePath: "C:\\Hermes\\tools\\python.exe",
  executableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) },
  executableArgsPrefix: ["-I", "-B", "-c", "bootstrap"],
  hermesHome: "C:\\Users\\test\\.hermes",
  environment: { HERMES_HOME: "C:\\Users\\test\\.hermes" },
};

describe("Hermes launch ticket", () => {
  it("binds the installed entrypoints, shared Hermes home, and one Run attempt", () => {
    const ticket = createHermesLaunchTicket(input);
    const consumed = consumeHermesLaunchTicket(ticket, {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    });
    expect(consumed.hermesExecutableIdentity).toEqual(input.hermesExecutableIdentity);
    expect(consumed.sourceCommit).toBe(HERMES_PROVIDER_SELECTION_SOURCE.commit);
    expect(consumed.executableIdentity).toEqual(input.executableIdentity);
    expect(consumed.hermesHome).toBe(input.hermesHome);
  });

  it("can be consumed only once", () => {
    const ticket = createHermesLaunchTicket(input);
    const request = {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    };
    consumeHermesLaunchTicket(ticket, request);
    expect(() => consumeHermesLaunchTicket(ticket, request)).toThrow("HERMES_LAUNCH_TICKET_REUSED");
  });

  it("rejects a different Run, executable, argument prefix, or Hermes environment", () => {
    const mismatch = (request: Parameters<typeof consumeHermesLaunchTicket>[1]) =>
      expect(() => consumeHermesLaunchTicket(createHermesLaunchTicket(input), request))
        .toThrow("HERMES_LAUNCH_TICKET_MISMATCH");
    const base = {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    };
    mismatch({ ...base, runId: "123e4567-e89b-42d3-a456-426614174001" });
    mismatch({ ...base, executable: "C:\\other\\python.exe" });
    mismatch({ ...base, args: ["-c", "untrusted"] });
    mismatch({ ...base, environment: { HERMES_HOME: "C:\\other\\profile" } });
  });

  it("rejects a CMD launcher paired with a non-Python runtime image", () => {
    expect(() => createHermesLaunchTicket({ ...input, executablePath: "C:\\Hermes\\bin\\cmd.exe" }))
      .toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });

  it("accepts a valid discovered source commit and rejects malformed commit identity", () => {
    const installedCommit = "9244275491" + "0".repeat(30);
    const ticket = createHermesLaunchTicket({ ...input, sourceCommit: installedCommit });
    const consumed = consumeHermesLaunchTicket(ticket, {
      runId: input.runId, attempt: input.attempt, executable: input.executablePath,
      args: [...input.executableArgsPrefix, "chat"], environment: input.environment,
    });
    expect(consumed.sourceCommit).toBe(installedCommit);
    expect(() => createHermesLaunchTicket({ ...input, sourceCommit: "f".repeat(39) }))
      .toThrow("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  });
});
