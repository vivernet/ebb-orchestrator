import { ProcessExecutor } from "../../platform/process/process-executor.js";

export class GitCli {
  private readonly executor: ProcessExecutor;

  constructor(executor?: ProcessExecutor) {
    this.executor = executor ?? new ProcessExecutor();
  }

  /**
   * Runs a git command safely without shell interpretation.
   * All arguments are passed as separate array elements to prevent shell injection.
   */
  async run(repoPath: string, args: string[]): Promise<
ProcessExecutor["exec"]> {
    return this.executor.exec("git", args, {
      cwd: repoPath,
      timeout: 60000, // 1 minute for git operations
    });
  }
}
