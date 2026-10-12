import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildHermesInstalledRuntimeArgs } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";

const execute = promisify(execFile);
const enabled = process.env.EBB_RUN_HERMES_MCP_REGISTRATION_ACCEPTANCE === "1";

/** Real installed Hermes + stdio MCP fixture; proves registration, never provider acceptance. */
describe.skipIf(!enabled)("Hermes in-memory MCP registration — installed source, provider-free", () => {
  it("registers only the Ebb toolset without writing provider configuration", async () => {
    const source = required("EBB_TEST_HERMES_SOURCE_ROOT");
    const python = required("EBB_TEST_HERMES_PYTHON");
    const dependencies = required("EBB_TEST_HERMES_DEPENDENCIES");
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    const { stdout: commit } = await execute("git", ["-C", source, "rev-parse", "HEAD"], {
      env: environment, timeout: 10_000, windowsHide: true,
    });
    expect(commit.trim()).toMatch(/^[a-f0-9]{40}$/u);
    const directory = await mkdtemp(join(tmpdir(), "ebb-mcp-registration-"));
    try {
      const probe = fileURLToPath(new URL("../fixtures/hermes-in-memory-mcp-probe.py", import.meta.url));
      const server = fileURLToPath(new URL("../fixtures/hermes-in-memory-mcp-server.py", import.meta.url));
      const args = ["-I", "-B", "-S", probe, source, dependencies, server, directory];
      await expect(execute(python, [...args, "missing"], {
        env: environment, timeout: 30_000, windowsHide: true,
      })).rejects.toMatchObject({ stderr: expect.stringContaining("EBB_MCP_REGISTRATION_MISSING") });
      const result = await execute(python, [...args, "register"], {
        env: environment, timeout: 30_000, windowsHide: true,
      });
      expect(result.stdout.trim()).toBe("HERMES_IN_MEMORY_MCP_OK");
      expect(result.stderr).toBe("");

      const productionHome = join(directory, "production-bootstrap-home");
      const productionArgs = buildHermesInstalledRuntimeArgs({
        hermesProjectRoot: source,
        sourceCommit: commit.trim(),
        runtimeExecutablePath: python,
        hermesHome: productionHome,
        mcpServer: { command: python, args: ["-I", "-B", server] },
      });
      const production = await execute(python, [...productionArgs, "chat", "--help"], {
        cwd: process.cwd(), env: environment, timeout: 30_000, windowsHide: true,
      });
      expect(production.stdout.toLowerCase()).toContain("usage:");
      expect(production.stderr).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 70_000);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`REGISTRATION_ACCEPTANCE_INPUT_REQUIRED:${name}`);
  return value;
}
