/**
 * CommandTools provides controlled command execution with environment isolation.
 * It executes commands without shell syntax, preferring explicit executable + args.
 */
import { EnvironmentBuilder } from '../../platform/security/environment-builder.js';
import { ProcessExecutor } from '../../platform/process/process-executor.js';
import * as path from 'node:path';

export type ExecOptions = {
  executable: string;
  args: string[];
  timeout?: number;
  maxOutput?: number;
  signal?: AbortSignal;
};

export type ExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ProjectAction = 'test' | 'lint' | 'typecheck' | 'build';

export enum ShellType {
  bash = 'bash', sh = 'sh', zsh = 'zsh', cmd = 'cmd', powershell = 'powershell', pwsh = 'pwsh',
}
const SHELL_EXECUTABLES = new Set(Object.values(ShellType));
const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class CommandTools {
  private readonly envBuilder = new EnvironmentBuilder();
  private readonly executor = new ProcessExecutor();

  isShellExecutable(executable: string): boolean {
    const baseName = path.basename(executable.toLowerCase()).replace(/\.exe$/, '');
    return SHELL_EXECUTABLES.has(baseName as ShellType);
  }

  async exec(options: ExecOptions, cwd: string, injectedEnv: Record<string, string> = {}): Promise<ExecResult> {
    const env = this.envBuilder.build({ allowlist: ['PATH'], injected: injectedEnv });
    try {
      const result = await this.executor.exec(options.executable, options.args, {
        cwd,
        env,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: options.maxOutput ?? DEFAULT_MAX_OUTPUT,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const exitCode = 'exitCode' in failure && typeof failure.exitCode === 'number' ? failure.exitCode : null;
      const stdout = 'stdout' in failure && typeof failure.stdout === 'string' ? failure.stdout : '';
      const stderr = 'stderr' in failure && typeof failure.stderr === 'string' ? failure.stderr : failure.message;
      return { success: false, stdout, stderr, exitCode };
    }
  }

  async test(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> { return this.exec(options, cwd, injectedEnv); }
  async lint(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> { return this.exec(options, cwd, injectedEnv); }
  async typecheck(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> { return this.exec(options, cwd, injectedEnv); }
  async build(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> { return this.exec(options, cwd, injectedEnv); }
}
