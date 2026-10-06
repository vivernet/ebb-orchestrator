import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupHermesRunProfileHome,
  createHermesRunProfileHome,
} from "../../src/platform/home/hermes-profile-home.js";
import {
  HERMES_PROVIDER_SELECTION_SOURCE,
  readHermesProviderSelection,
} from "../../src/modules/runtime/hermes/hermes-provider-selection.js";

const runId = "c9b640db-9fbf-4d1f-b8a8-91e74093772b";

/**
 * Это сквозная проверка только plumbing между bounded selection projection и per-Run profile API.
 * Выход scanner-а — синтетический fixture; helper runner не обращается к Hermes или OS.
 * Успех не доказывает native auth, refresh, доступ к credentials или provider request.
 */
describe("Hermes profile/auth-source path mechanics — fixture only, no auth/provider acceptance", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("passes only the Run-bound profile path after an explicit bounded selection projection", async () => {
    expect(["win32", "linux"]).toContain(process.platform);
    root = await mkdtemp(join(tmpdir(), "ebb-hermes-profile-auth-source-fixture-"));
    const platform = process.platform as "win32" | "linux";
    const paths = platform === "win32" ? await import("node:path/win32") : await import("node:path/posix");
    const hermesRoot = paths.join(root, "hermes-auth-root");
    const projectRoot = paths.join(root, "hermes-install");
    const helperPath = paths.join(root, "native", platform === "win32" ? "helper.exe" : "helper");
    const plannedProfileHome = paths.join(hermesRoot, "profiles", `ebb-orchestrator-run-${runId}`);
    const commands: Array<{ command: string; args: string[]; input?: string }> = [];
    const scannerFixture = async (
      _executable: string,
      args: string[],
      options: { shell: false; maxOutputBytes: number; input?: string },
    ): Promise<string> => {
      const command = args[0];
      commands.push({ command: command ?? "", args, ...(options.input === undefined ? {} : { input: options.input }) });
      if (command === "project-selection") {
        return JSON.stringify({
          sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
          sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
          projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
          status: "EXPLICIT_SELECTION",
          providerId: "fireworks",
          modelId: "fixture-model",
          endpointOverridePresent: false,
        });
      }
      throw new Error("FIXTURE_COMMAND_NOT_ALLOWED");
    };
    const selection = await readHermesProviderSelection({
      hermesConfigHome: hermesRoot,
      hermesRunProfileHome: plannedProfileHome,
      runId,
      hermesProjectRoot: projectRoot,
      runEnvironment: {},
      helperPath,
      platform,
      runHelper: scannerFixture,
    });

    expect(selection).toEqual({
      providerId: "fireworks",
      modelId: "fixture-model",
      endpointOverridePresent: false,
      endpointIdentityEligible: true,
      endpointIdentity: "hermes-provider:fireworks",
      endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    });
    expect(JSON.stringify(selection)).not.toMatch(/https?:|credential|secret/iu);

    const profileHome = await createHermesRunProfileHome({
      hermesRoot,
      runId,
      helperPath,
      platform,
      verifyHelper: async () => undefined,
      runHelper: async (_executable, args, options) => {
        commands.push({ command: args[0] ?? "", args, ...(options.input === undefined ? {} : { input: options.input }) });
      },
    });
    expect(profileHome).toBe(plannedProfileHome);
    expect(commands.map(({ command }) => command)).toEqual(["project-selection", "create-profile"]);
    expect(commands[1]?.args).toEqual(["create-profile", hermesRoot, runId]);
    expect(commands[1]?.input).toBeUndefined();

    await cleanupHermesRunProfileHome({
      hermesRoot,
      runId,
      helperPath,
      platform,
      verifyHelper: async () => undefined,
      runHelper: async (_executable, args, options) => {
        commands.push({ command: args[0] ?? "", args, ...(options.input === undefined ? {} : { input: options.input }) });
      },
    });
    expect(commands.map(({ command }) => command)).toEqual(["project-selection", "create-profile", "cleanup-profile"]);
    expect(commands[2]?.args).toEqual(["cleanup-profile", hermesRoot, runId]);
    expect(JSON.stringify(commands)).not.toMatch(/https?:|credential|secret/iu);
  });

  it("rejects an ambiguous selection before requesting any per-Run profile operation", async () => {
    root = await mkdtemp(join(tmpdir(), "ebb-hermes-profile-auth-reject-fixture-"));
    const platform = process.platform as "win32" | "linux";
    const paths = platform === "win32" ? await import("node:path/win32") : await import("node:path/posix");
    const hermesRoot = paths.join(root, "hermes-auth-root");
    const plannedProfileHome = paths.join(hermesRoot, "profiles", `ebb-orchestrator-run-${runId}`);
    const helperPath = paths.join(root, "native", platform === "win32" ? "helper.exe" : "helper");
    const calls: string[] = [];

    await expect(readHermesProviderSelection({
      hermesConfigHome: hermesRoot,
      hermesRunProfileHome: plannedProfileHome,
      runId,
      hermesProjectRoot: paths.join(root, "hermes-install"),
      runEnvironment: {},
      helperPath,
      platform,
      runHelper: async (_executable, args) => {
        calls.push(args[0] ?? "");
        return JSON.stringify({
          sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
          sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
          projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
          status: "UNAVAILABLE",
          reason: "HERMES_SELECTION_NOT_EXPLICIT",
          endpointOverridePresent: false,
        });
      },
    })).rejects.toThrow("HERMES_SELECTION_NOT_EXPLICIT");
    expect(calls).toEqual(["project-selection"]);
  });
});
