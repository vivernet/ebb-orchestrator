/**
 * Hermes CLI builder - constructs hermes command-line arguments.
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
 * Builder for constructing hermes CLI arguments.
 */
export class HermesCliBuilder {
  /**
   * Builds launch arguments for a new hermes run.
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
   * Builds resume arguments for continuing a hermes session.
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
