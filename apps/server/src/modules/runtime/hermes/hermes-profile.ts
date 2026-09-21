/**
 * Hermes profile builder - creates isolated launch profiles.
 */

import type { HermesLaunchProfile, HermesRunBuildConfig } from "./hermes-config.js";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "node:url";

/** Этот launcher is deliberately independent of pnpm bin shims and cwd. */
function defaultMcpLauncher(): { command: string; args: string[] } {
  const entrypoint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/ebb-orchestrator-mcp.js");
  return { command: process.execPath, args: [entrypoint] };
}

/**
 * Orchestrator home directory.
 */
export function getOrchestratorHome(): string {
  return process.env.EBB_ORCHESTRATOR_HOME ?? path.join(os.homedir(), ".ebb-orchestrator");
}

/**
 * Формирует Hermes profile for a run.
 *
 * Этот creates an isolated profile:
 * - Sets HERMES_HOME under orchestrator runtime
 * - Sets HOME inside HERMES_HOME for subprocess isolation
 * - Removes sensitive credentials (GITHUB_TOKEN, SSH_AUTH_SOCK)
 * - Исключает inherited personal Hermes profiles
 */
export function prepareHermesProfile(run: HermesRunBuildConfig): HermesLaunchProfile {
  const orchestratorHome = run.orchestratorHome;
  const hermesHome = path.join(orchestratorHome, "runtime", "hermes");
  const hermesHomePath = path.join(hermesHome, "home");

  // Start with an explicit runtime/Hermes allowlist; never clone process.env.
  const baseEnv: Record<string, string> = {};
  const allowed = ["PATH", "HOME", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "NODE_PATH", "NODE_ENV"];
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) baseEnv[key] = value;
  }

  if (run.environment?.GITHUB_TOKEN !== undefined || run.environment?.SSH_AUTH_SOCK !== undefined) {
    throw new Error("Forbidden credential in supplied runtime environment");
  }
  const injectedAllowed = new Set(["PATH", "NODE_PATH", "NODE_ENV", "HERMES_MODEL"]);
  for (const [key, value] of Object.entries(run.environment ?? {})) {
    if (!injectedAllowed.has(key)) throw new Error(`Forbidden or unknown Hermes environment variable: ${key}`);
    baseEnv[key] = value;
  }

  // Override critical environment variables for isolation
  baseEnv.HERMES_HOME = hermesHome;
  baseEnv.HOME = hermesHomePath;
  // Применяет the boundary after all overlays so inherited or supplied credentials cannot win.
  delete baseEnv.GITHUB_TOKEN;
  delete baseEnv.SSH_AUTH_SOCK;
  delete baseEnv.HERMES_PROFILE;

  // Формирует toolset reference
  const toolsetName = [run.toolsetPath];

  return {
    hermesHome: hermesHome,
    env: baseEnv,
    toolsetName: toolsetName,
  };
}

/**
 * Получает config path within Hermes home.
 */
export function getConfigPath(hermesHome: string): string {
  return path.join(hermesHome, "config.yaml");
}

/**
 * Получает MCP socket path.
 */
export function getMcpSocketPath(hermesHome: string): string {
  return path.join(hermesHome, "mcp.sock");
}

/**
 * Configuration for generating hermes config.yaml.
 */
export interface GenerateConfigOptions {
  capability: { role: string; workspace: string };
  capabilityRef?: string;
  toolsetPath: string;
  resultFile?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
}

/**
 * Формирует config.yaml content for Hermes runtime.
 *
 * Этот creates a minimal config with only Orchestrator-managed settings:
 * - MCP server definition referencing ebb-orchestrator-mcp
 * - Terminal configuration with home_mode: profile
 */
export function generateConfigYaml(options: GenerateConfigOptions): string {
  const { toolsetPath, resultFile } = options;
  const defaultLauncher = defaultMcpLauncher();
  const mcpCommand = options.mcpCommand && options.mcpCommand !== "ebb-orchestrator-mcp"
    ? options.mcpCommand
    : defaultLauncher.command;
  const mcpArgs = options.mcpCommand && options.mcpCommand !== "ebb-orchestrator-mcp"
    ? (options.mcpArgs ?? [])
    : [...defaultLauncher.args, ...(options.mcpArgs ?? [])];
  const capabilityRef = options.capabilityRef ?? "orchestrator-issued-reference";
  const executableArgs = [...mcpArgs, "--capability-ref", capabilityRef, "--toolset", toolsetPath, ...(resultFile ? ["--result-file", resultFile] : [])];
  const yamlString = (value: string): string => JSON.stringify(value);

  const yaml = [
    "mcp_servers:",
    "  ebb-orchestrator-mcp:",
    `    command: ${yamlString(mcpCommand)}`,
    "    args:",
    ...executableArgs.map((arg) => `      - ${yamlString(arg)}`),
    "terminal:",
    "  home_mode: profile",
    "",
  ].join("\n");

  return yaml;
}
