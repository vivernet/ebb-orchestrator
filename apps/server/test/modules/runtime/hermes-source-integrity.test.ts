import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesInstalledRuntimeArgs } from "../../../src/modules/runtime/hermes/hermes-executable-resolver.js";

let fixtureRoot = "";
afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("installed Hermes source admission", () => {
  it("runs the configured source directly without Git metadata or cleanliness checks", async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "ebb-hermes-direct-source-"));
    const source = path.join(fixtureRoot, "hermes-agent");
    const python = process.platform === "win32" ? "C:\\Python\\python.exe" : "/usr/bin/python3";
    const hermesHome = path.join(fixtureRoot, "configured-hermes");
    await mkdir(path.join(source, "hermes_cli"), { recursive: true });
    await writeFile(path.join(source, "hermes_bootstrap.py"), "# fixture bootstrap\n");
    await writeFile(path.join(source, "hermes_cli", "main.py"), "print('HERMES_SOURCE_RAN')\n");

    const args = buildHermesInstalledRuntimeArgs({ hermesProjectRoot: source, runtimeExecutablePath: python, hermesHome });
    const bootstrap = args[3] ?? "";
    expect(bootstrap).not.toContain("git");
    expect(bootstrap).not.toContain("source_commit");
    expect(bootstrap).toContain("import hermes_bootstrap");
    expect(bootstrap).toContain("runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)");
    expect(args.slice(0, 3)).toEqual(["-I", "-B", "-c"]);

    const changedArgs = buildHermesInstalledRuntimeArgs({ hermesProjectRoot: source, runtimeExecutablePath: python, hermesHome });
    await writeFile(path.join(source, "hermes_cli", "untracked_module.py"), "value = 1\n");
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", [...changedArgs], {
      encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("HERMES_SOURCE_RAN");
    expect(result.stderr).toBe("");
  });

  it("keeps in-memory Ebb MCP registration before CLI invocation", () => {
    const bootstrap = buildHermesInstalledRuntimeArgs({
      hermesProjectRoot: process.platform === "win32" ? "C:\\Hermes\\hermes-agent" : "/opt/hermes/hermes-agent",
      runtimeExecutablePath: process.platform === "win32" ? "C:\\Python\\python.exe" : "/usr/bin/python3",
      hermesHome: process.platform === "win32" ? "C:\\Users\\alice\\.hermes" : "/home/alice/.hermes",
      mcpServer: { command: "node", args: ["ebb-mcp.js"] },
    })[3] ?? "";
    expect(bootstrap.indexOf("register_mcp_servers(ebb_mcp)")).toBeLessThan(bootstrap.indexOf("runpy.run_module('hermes_cli.main'"));
    expect(bootstrap).toContain("mcp__ebb_orchestrator__submit_result");
    expect(bootstrap).toContain("HERMES_EBB_MCP_REGISTRATION_FAILED");
  });
});
