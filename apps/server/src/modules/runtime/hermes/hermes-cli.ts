/**
 * Hermes CLI builder - constructs hermes command-line аргументы.
 */

export interface LaunchArgs {
  queryFile: string;
  model: string;
  toolsets: string[];
  worktree: string;
  ignoreRules: boolean;
  source: string;
  maxTurns: number;
}

export interface ResumeArgs {
  sessionId: string;
  toolsets: string[];
  worktree: string;
  ignoreRules: boolean;
  source: string;
  maxTurns: number;
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

    // --model <resolved-model>
    result.push("--model", args.model);

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

    return result;
  }

  /**
   * Формирует аргументы возобновления для continuing Объект hermes сессия.
   */
  buildResumeArgs(args: ResumeArgs): string[] {
    const result: string[] = ["chat"];

    // --resume <session-id>
    result.push("--resume", args.sessionId);

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

    return result;
  }
}
