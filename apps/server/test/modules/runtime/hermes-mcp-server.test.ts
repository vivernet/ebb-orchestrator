import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHermesMcpServer, defaultMcpLauncher } from "../../../src/modules/runtime/hermes/hermes-mcp-server.js";

describe("buildHermesMcpServer", () => {
  it("uses explicit Node flags and entrypoint without prepending the default script", () => {
    const server = buildHermesMcpServer({
      capabilityRef: "capability-ref",
      resultFile: "result.json",
      mcpCommand: process.execPath,
      mcpArgs: ["--import", "tsx-loader", "mcp-entrypoint.ts"],
    });

    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      "--import", "tsx-loader", "mcp-entrypoint.ts",
      "--capability-ref", "capability-ref", "--result-file", "result.json",
    ]);
  });

  it("uses the default production entrypoint for the canonical launcher alias", () => {
    const server = buildHermesMcpServer({
      capabilityRef: "capability-ref",
      resultFile: "result.json",
      mcpCommand: "ebb-orchestrator-mcp",
      mcpArgs: ["--database", "state.sqlite"],
    });

    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      resolve(import.meta.dirname, "../../../../../node_modules/tsx/dist/cli.mjs"),
      resolve(import.meta.dirname, "../../../src/bin/ebb-orchestrator-mcp.ts"),
      "--database", "state.sqlite",
      "--capability-ref", "capability-ref", "--result-file", "result.json",
    ]);
  });

  it("uses only the emitted JavaScript entrypoint for a packaged server", () => {
    const packagedModuleUrl = pathToFileURL(resolve(
      import.meta.dirname,
      "../../../dist/modules/runtime/hermes/hermes-mcp-server.js",
    )).href;

    expect(defaultMcpLauncher(packagedModuleUrl)).toEqual({
      command: process.execPath,
      args: [resolve(import.meta.dirname, "../../../dist/bin/ebb-orchestrator-mcp.js")],
    });
  });

});
