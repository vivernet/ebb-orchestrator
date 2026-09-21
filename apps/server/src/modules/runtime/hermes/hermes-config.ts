/**
 * Hermes конфигурация типы.
 */

/**
 * Выполняет capability - defines what the run is authorized to do.
 */
export interface RunCapability {
  /** роль name. */
  role: string;
  /** Workspace путь. */
  workspace: string;
}

/**
 * MCP-сервер definition in config.yaml.
 */
export interface McpServer {
  /** Unique сервер name/key. */
  name: string;
  /** Этот command to run. */
  command: string;
  /** аргументы to pass to Объект команда. */
  args?: string[];
  /** переменные окружения для Объект сервер процесс. */
  env?: Record<string, string>;
}

/**
 * Terminal конфигурация section.
 */
export interface TerminalConfig {
  /** Настройка режима home. */
  home_mode: "profile";
}

/**
 * Конфигурация Hermes, управляемая Orchestrator.
 */
export interface HermesConfig {
  /** MCP-серверs defined by orchestrator. */
  mcp_servers: McpServer[];
  /** Настройки терминала. */
  terminal: TerminalConfig;
}

/**
 * Конфигурация запуска профиля.
 */
export interface HermesLaunchProfile {
  /** путь to Hermes home directory. */
  hermesHome: string;
  /** переменные окружения для Объект Hermes процесс. */
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
  /** Explicit runtime переменные; forbidden credentials являются rejected. */
  environment?: Record<string, string>;
}
