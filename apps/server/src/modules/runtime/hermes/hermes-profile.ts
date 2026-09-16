/**
 * Hermes profile builder - creates isolated launch profiles.
 */

import type { HermesLaunchProfile, HermesRunBuildConfig } from "./hermes-config.js";
import * as path from "path";
import * as os from "os";

/**
 * Orchestrator home directory.
 */
export function getOrchestratorHome(): string {
  return process.env.ORCHESTRATOR_HOME ?? path.join(os.homedir(), ".orchestrator");
}

/**
 * Build Hermes profile for a run.
 *
 * This creates an isolated profile:
 * - Sets HERMES_HOME under orchestrator runtime
 * - Sets HOME inside HERMES_HOME for subprocess isolation
 * - Removes sensitive credentials (GITHUB_TOKEN, SSH_AUTH_SOCK)
 * - Excludes inherited personal Hermes profiles
 */
export function prepareHermesProfile(run: HermesRunBuildConfig): HermesLaunchProfile {
  const orchestratorHome = run.orchestratorHome;
  const hermesHome = path.join(orchestratorHome, "runtime", "hermes");
  const hermesHomePath = path.join(hermesHome, "home");

  // Start with base environment but strip sensitive vars
  const baseEnv: Record<string, string> = {};
  
  // Copy non-sensitive environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Skip sensitive credentials
    if (key === "GITHUB_TOKEN" || key === "SSH_AUTH_SOCK" || key === "HERMES_PROFILE") {
      continue;
    }
    baseEnv[key] = value;
  }

  // Override critical environment variables for isolation
  baseEnv.HERMES_HOME = hermesHome;
  baseEnv.HOME = hermesHomePath;

  // Build toolset reference
  const toolsetName = [run.toolsetPath];

  return {
    hermesHome: hermesHome,
    env: baseEnv,
    toolsetName: toolsetName,
  };
}

/**
 * Get config path within Hermes home.
 */
export function getConfigPath(hermesHome: string): string {
  return path.join(hermesHome, "config.yaml");
}

/**
 * Get MCP socket path.
 */
export function getMcpSocketPath(hermesHome: string): string {
  return path.join(hermesHome, "mcp.sock");
}
