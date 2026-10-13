import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentRuntimeRun } from "../../../src/modules/runtime/agent-runtime.js";
import { createHermesManagedSelectionFixture } from "../../helpers/hermes-managed-selection-fixture.js";
import type { HermesLaunchObjectIdentity, HermesLaunchTicket } from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-source-identity.js";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";

describe("direct installed Hermes launch authorization", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
    vi.resetModules();
  });

  it("registers Ebb MCP in memory and binds the shared Hermes home to one Run", async () => {
    const platform = process.platform === "win32" ? "win32" : "linux";
    const paths = platform === "win32" ? path.win32 : path.posix;
    const root = await import("node:os").then(({ tmpdir }) => tmpdir());
    const runId = randomUUID();
    const hermesHome = paths.join(root, "configured-hermes");
    const objectIdentity = platform === "win32"
      ? { platform, volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) } as const
      : { platform, device: "1", inode: "2" } as const;
    const pythonIdentity = platform === "win32"
      ? { platform, volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) } as const
      : { platform, device: "1", inode: "3" } as const;
    let resolvedHermesIdentity: HermesLaunchObjectIdentity = objectIdentity;
    let resolvedPythonIdentity: HermesLaunchObjectIdentity = pythonIdentity;

    vi.doUnmock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
    vi.resetModules();
    vi.doMock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js", () => ({
      resolveHermesExecutable: vi.fn(async () => ({
        executablePath: paths.join(root, platform === "win32" ? "hermes.cmd" : "hermes"),
        executableIdentity: resolvedHermesIdentity,
        runtimeExecutablePath: paths.join(root, platform === "win32" ? "python.exe" : "python3"),
        runtimeExecutableIdentity: resolvedPythonIdentity,
        hermesProjectRoot: paths.join(root, "hermes-agent"),
        sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
        hermesConfigHome: hermesHome,
      })),
      buildHermesInstalledRuntimeArgs: vi.fn(({ hermesProjectRoot }: { hermesProjectRoot: string }) =>
        ["-I", "-B", "-c", `sys.path.insert(0, ${JSON.stringify(hermesProjectRoot)})\nregister_ebb_mcp_in_memory()`]),
    }));

    const { HermesRuntimeAdapter } = await import("../../../src/modules/runtime/hermes/hermes-runtime-adapter.js");
    const { consumeHermesLaunchTicket } = await import("../../../src/modules/runtime/hermes/hermes-launch-ticket.js");
    const adapter = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
      mcpCommand: "ebb-orchestrator-mcp", mcpArgs: ["--stdio"],
    });
    const runtimeIdentity = JSON.stringify({ platform, hermes: objectIdentity, python: pythonIdentity,
      sourceCommit: null });
    const selection = createHermesManagedSelectionFixture(runId, runtimeIdentity, hermesHome);
    const run = {
      id: runId, role: "developer", runtime: "hermes", model: "default", taskId: "task",
      epicId: null, status: "STARTED", sessionId: null, attempt: 1, triggerReason: "custom",
      contextVersion: "v1", outputSchemaVersion: "1", startedAt: new Date(), endedAt: null,
      exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      capabilityRef: "fixture-capability", hermesSelection: selection,
    } satisfies AgentRuntimeRun;
    const authorize = (adapter as unknown as {
      createLaunchAuthorization: (
        run: AgentRuntimeRun, cwd: string, hermesHome: string,
        environment: { HERMES_HOME: string; HOME: string }, resultPath: string,
      ) => Promise<{ executablePath: string; argsPrefix: readonly string[]; ticket: HermesLaunchTicket }>;
    }).createLaunchAuthorization.bind(adapter);

    const environment = { HERMES_HOME: hermesHome, HOME: root };
    const prepared = await authorize(run, root, hermesHome, environment, paths.join(root, "result.json"));
    expect(prepared.argsPrefix.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
    expect(prepared.argsPrefix[3]).toContain("register_ebb_mcp_in_memory");
    const authorized = consumeHermesLaunchTicket(prepared.ticket, {
      runId, attempt: 1, executable: prepared.executablePath,
      args: [...prepared.argsPrefix, "chat"], environment,
    });
    expect(authorized).toMatchObject({ runId, attempt: 1, hermesHome, environment });
    expect(authorized).not.toHaveProperty("hermesSourceSnapshotKey");

    resolvedHermesIdentity = platform === "win32"
      ? { platform, volumeSerial: "0123456789abcdef", fileId: "c".repeat(32) }
      : { platform, device: "1", inode: "4" };
    await expect(authorize(run, root, hermesHome, environment, paths.join(root, "result.json")))
      .rejects.toThrow("HERMES_RUNTIME_IDENTITY_CHANGED");
    resolvedHermesIdentity = objectIdentity;
    resolvedPythonIdentity = platform === "win32"
      ? { platform, volumeSerial: "0123456789abcdef", fileId: "d".repeat(32) }
      : { platform, device: "1", inode: "5" };
    await expect(authorize(run, root, hermesHome, environment, paths.join(root, "result.json")))
      .rejects.toThrow("HERMES_RUNTIME_IDENTITY_CHANGED");

    const malformedSelection = createHermesManagedSelectionFixture(runId, JSON.stringify({
      platform, hermes: objectIdentity, python: pythonIdentity, sourceCommit: "f".repeat(40), unexpected: true,
    }), hermesHome);
    const malformedRun = { ...run, hermesSelection: malformedSelection } satisfies AgentRuntimeRun;
    await expect(authorize(malformedRun, root, hermesHome, environment, paths.join(root, "result.json")))
      .rejects.toThrow("HERMES_RUNTIME_IDENTITY_CHANGED");
  });
});
