import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Возвращает собственный MCP entrypoint независимо от pnpm shims и текущего каталога. */
export function defaultMcpLauncher(moduleUrl: string = import.meta.url): { command: string; args: string[] } {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const sourceMode = path.extname(fileURLToPath(moduleUrl)) === ".ts";
  const entrypoint = path.resolve(moduleDirectory, `../../../bin/ebb-orchestrator-mcp.${sourceMode ? "ts" : "js"}`);
  const args = sourceMode
    ? [path.resolve(moduleDirectory, "../../../../../../node_modules/tsx/dist/cli.mjs"), entrypoint]
    : [entrypoint];
  return { command: process.execPath, args };
}

/**
 * Формирует MCP definition для регистрации в памяти Hermes без чтения или записи его конфигурации.
 *
 * @param options Аргументы MCP definition.
 * @param options.capabilityRef Capability reference, выданный Orchestrator для Run.
 * @param options.resultFile Controlled result file для результата Run.
 * @param options.mcpCommand Настроенный executable MCP launcher, если задан.
 * @param options.mcpArgs Дополнительные аргументы MCP launcher, если заданы.
 * @returns Команду и аргументы существующего Ebb MCP entrypoint для текущего Run.
 * @throws {Error} Если отсутствует выданный Orchestrator capability reference.
 */
export function buildHermesMcpServer(options: {
  capabilityRef?: string;
  resultFile: string;
  mcpCommand?: string;
  mcpArgs?: string[];
}): { command: string; args: string[] } {
  if (!options.capabilityRef) throw new Error("HERMES_MCP_CAPABILITY_REQUIRED");
  const launcher = defaultMcpLauncher();
  const custom = Boolean(options.mcpCommand && options.mcpCommand !== "ebb-orchestrator-mcp");
  const command = custom ? options.mcpCommand ?? launcher.command : launcher.command;
  return {
    command,
    args: [...(custom ? [] : launcher.args), ...(options.mcpArgs ?? []),
      "--capability-ref", options.capabilityRef, "--result-file", options.resultFile],
  };
}

