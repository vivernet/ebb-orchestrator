/**
 * ProjectActions предоставляет типизированные соответствия для проект operations (test, lint, typecheck, сборка)
 * based on approved проект конфигурация.
 */
import { CommandTools } from './command-tools.js';
import type { ExecOptions } from './command-tools.js';

export type ProjectAction = 'test' | 'lint' | 'typecheck' | 'build';

export type ProjectConfig = {
  /** команды to run для каждого действие тип */
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

/**
 * Предоставляет execution-контракт project-actions с проверкой capability перед побочным эффектом.
 */
export class ProjectActions {
  private commandTools: CommandTools;

  constructor(private readonly projectConfig: ProjectConfig) {
    this.commandTools = new CommandTools();
  }

  /**
   * Execute Объект проект test действие using Объект настроенную команду.
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
   * Execute Объект проект lint действие using Объект настроенную команду.
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
   * Execute Объект проект typecheck действие using Объект настроенную команду.
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
   * Execute Объект проект сборка действие using Объект настроенную команду.
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
   * Получает the configured options for a specific action.
   * Falls back to стандартные команды если не настроено.
   */
  private getConfiguredOptions(action: ProjectAction): ExecOptions {
    const configured = this.projectConfig.commands[action];
    if (!configured) {
      throw new Error(`project action is not configured: ${action}`);
    }
    return configured;
  }
}
