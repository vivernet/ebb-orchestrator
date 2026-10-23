/**
 * Hermes CLI builder - constructs hermes command-line аргументы.
 */

export interface LaunchArgs {
  queryFile: string;
  toolsets: string[];
  worktree: string;
  ignoreRules: boolean;
  source: string;
  maxTurns: number;
  /** Имя провайдера при явном выборе модели (built-in реестр). */
  provider?: string;
  /** Явно выбранная модель (отлична от "default"). */
  model?: string;
}

export interface ResumeArgs {
  sessionId: string;
  queryFile: string;
  toolsets: string[];
  worktree: string;
  ignoreRules: boolean;
  source: string;
  maxTurns: number;
  /** Имя провайдера при явном выборе модели (built-in реестр). */
  provider?: string;
  /** Явно выбранная модель (отлична от "default"). */
  model?: string;
}

/**
 * Builder для constructing hermes CLI аргументы.
 */
export class HermesCliBuilder {
  /**
   * Формирует аргументы запуска для Объект новый hermes run.
   */
  buildLaunchArgs(args: LaunchArgs): string[] {
    const result: string[] = ["chat"];

    // --query-file <prompt-file>
    result.push("--query-file", args.queryFile);

    // --toolsets mcp-orchestrator
    result.push("--toolsets", args.toolsets.join(","));

    // --in <managed-worktree>
    result.push("--in", args.worktree);

    // --ignore-rules
    if (args.ignoreRules) {
      result.push("--ignore-rules");
    }

    // --source tool
    result.push("--source", args.source);

    // The session capture contract relies on Hermes' newline-delimited event stream.
    result.push("--format", "stream-json");

    // --max-turns <role-limit>
    result.push("--max-turns", String(args.maxTurns));

    // Явный выбор провайдера/модели: фиксирует provider/model и отключает
    // чтение пользовательской конфигурации Hermes (oneshot, ignore-user-config).
    if (args.provider && args.model) {
      result.push("--provider", args.provider);
      result.push("-m", args.model);
      result.push("--oneshot");
      result.push("--ignore-user-config");
    }

    return result;
  }

  /**
   * Возобновляет сохранённую сессию с явным continuation turn в режиме stream-json.
   * Запрещает Hermes восстанавливать прежний cwd поверх управляемого worktree.
   */
  buildResumeArgs(args: ResumeArgs): string[] {
    const result: string[] = ["chat"];
    result.push("--format", "stream-json");

    // --resume <session-id>
    result.push("--resume", args.sessionId);
    result.push("--query-file", args.queryFile);
    result.push("--no-restore-cwd");

    // --toolsets mcp-orchestrator
    result.push("--toolsets", args.toolsets.join(","));

    // --in <managed-worktree>
    result.push("--in", args.worktree);

    // --ignore-rules
    if (args.ignoreRules) {
      result.push("--ignore-rules");
    }

    // --source tool
    result.push("--source", args.source);

    // --max-turns <role-limit>
    result.push("--max-turns", String(args.maxTurns));

    // Явный выбор провайдера/модели: фиксирует provider/model и отключает
    // чтение пользовательской конфигурации Hermes (oneshot, ignore-user-config).
    if (args.provider && args.model) {
      result.push("--provider", args.provider);
      result.push("-m", args.model);
      result.push("--oneshot");
      result.push("--ignore-user-config");
    }

    return result;
  }
}
