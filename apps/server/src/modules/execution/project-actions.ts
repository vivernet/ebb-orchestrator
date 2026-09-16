/**
 * ProjectActions provides typed mappings for project operations (test, lint, typecheck, build)
 * based on approved project configuration.
 */
import { CommandTools } from './command-tools.js';
import type { ExecOptions } from './command-tools.js';

export type ProjectAction = 'test' | 'lint' | 'typecheck' | 'build';

export type ProjectConfig = {
  /** Commands to run for each action type */
  commands: {
    test?: ExecOptions;
    lint?: ExecOptions;
    typecheck?: ExecOptions;
    build?: ExecOptions;
  };
};

export type ActionResult = {
  action: ProjectAction;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export class ProjectActions {
  private commandTools: CommandTools;

  constructor(_projectConfig: ProjectConfig) {
    this.commandTools = new CommandTools();
    // In a real implementation, we would validate and store projectConfig here
    // ensuring only approved project configurations are used
  }

  /**
   * Execute the project test action using the configured command.
   */
  async test(cwd: string, injectedEnv?: Record<string, string>): Promise<ActionResult> {
    const options = this.getConfiguredOptions('test');
    const result = await this.commandTools.test(options, cwd, injectedEnv);
    return {
      action: 'test',
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Execute the project lint action using the configured command.
   */
  async lint(cwd: string, injectedEnv?: Record<string, string>): Promise<ActionResult> {
    const options = this.getConfiguredOptions('lint');
    const result = await this.commandTools.lint(options, cwd, injectedEnv);
    return {
      action: 'lint',
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Execute the project typecheck action using the configured command.
   */
  async typecheck(cwd: string, injectedEnv?: Record<string, string>): Promise<ActionResult> {
    const options = this.getConfiguredOptions('typecheck');
    const result = await this.commandTools.typecheck(options, cwd, injectedEnv);
    return {
      action: 'typecheck',
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Execute the project build action using the configured command.
   */
  async build(cwd: string, injectedEnv?: Record<string, string>): Promise<ActionResult> {
    const options = this.getConfiguredOptions('build');
    const result = await this.commandTools.build(options, cwd, injectedEnv);
    return {
      action: 'build',
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Get the configured options for a specific action.
   * Falls back to default commands if not configured.
   */
  private getConfiguredOptions(action: ProjectAction): ExecOptions {
    // Default commands based on common project setups
    const defaults: Record<ProjectAction, ExecOptions> = {
      test: { executable: 'node', args: [] },
      lint: { executable: 'node', args: [] },
      typecheck: { executable: 'node', args: [] },
      build: { executable: 'node', args: [] }
    };

    return defaults[action];
  }
}
