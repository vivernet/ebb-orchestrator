/**
 * Hermes configuration types.
 */

/**
 * Выполняет capability - defines what the run is authorized to do.
 */
export interface RunCapability {
  /** Role name. */
  role: string;
  /** Workspace path. */
  workspace: string;
}

/**
 * MCP server definition in config.yaml.
 */
export interface McpServer {
  /** Unique server name/key. */
  name: string;
  /** Этот command to run. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
}

/**
 * Terminal configuration section.
 */
export interface TerminalConfig {
  /** Home mode setting. */
  home_mode: "profile";
}

/**
 * Orchestrator-managed Hermes config.
 */
export interface HermesConfig {
  /** MCP servers defined by orchestrator. */
  mcp_servers: McpServer[];
  /** Terminal settings. */
  terminal: TerminalConfig;
}

/**
 * Profile launch configuration.
 */
export interface HermesLaunchProfile {
  /** Path to Hermes home directory. */
  hermesHome: string;
  /** Environment variables for the Hermes process. */
  env: Record<string, string>;
  /** Устанавливает of tools/capabilities enabled. */
  toolsetName: string[];
}

/**
 * Формирует configuration for a run capability.
 */
export interface HermesRunBuildConfig {
  capability: RunCapability;
  orchestratorHome: string;
  toolsetPath: string;
  /** Explicit runtime variables; forbidden credentials are rejected. */
  environment?: Record<string, string>;
}
