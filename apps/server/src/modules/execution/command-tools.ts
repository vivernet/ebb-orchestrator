/**
 * CommandTools provides controlled command execution with environment isolation.
 * It executes commands without shell syntax, preferring explicit executable + args.
 */
import { EnvironmentBuilder } from '../../platform/security/environment-builder.js';
import * as _childProcess from 'node:child_process';
import * as path from 'node:path';

export type ExecOptions = {
  executable: string;
  args: string[];
};

export type ExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ProjectAction = 'test' | 'lint' | 'typecheck' | 'build';

/**
 * Shell types that require separate permission (SHELL_EXECUTION capability).
 * These are treated differently from regular executables due to security risks.
 */
export enum ShellType {
  bash = 'bash',
  sh = 'sh',
  zsh = 'zsh',
  cmd = 'cmd',
  powershell = 'powershell',
  pwsh = 'pwsh',
}

const SHELL_EXECUTABLES = new Set(Object.values(ShellType));

export class CommandTools {
  private envBuilder: EnvironmentBuilder;

  constructor() {
    this.envBuilder = new EnvironmentBuilder();
  }

  /**
   * Check if an executable is a shell requiring special permission.
   */
  isShellExecutable(executable: string): boolean {
    const normalized = executable.toLowerCase();
    // Also check just the executable name without path
    const baseName = path.basename(normalized);
    return SHELL_EXECUTABLES.has(baseName as ShellType);
  }

  /**
   * Execute a command without shell syntax.
   * 
   * This method executes commands with explicit executable and args,
   * avoiding raw shell syntax that could introduce security risks.
   * 
   * @param options - The command to execute
   * @param cwd - Current working directory
   * @param injectedEnv - Optional environment variables to inject
   * @returns Execution result
   */
  async exec(
    options: ExecOptions,
    cwd: string,
    injectedEnv: Record<string, string> = {}
  ): Promise<ExecResult> {
    // Build isolated environment - does not inherit process.env by default
    const env = this.envBuilder.build({
      allowlist: ['PATH'],
      injected: injectedEnv
    });

    return new Promise((resolve) => {
       const spawned = _childProcess.spawn(
        options.executable,
        options.args,
        {
          cwd,
          env,
          shell: false, // Explicitly disable shell
        }
      );

      let stdout = '';
      let stderr = '';

      spawned.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      spawned.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      spawned.on('close', (code: number | null) => {
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code
        });
      });

      spawned.on('error', (error: Error) => {
        resolve({
          success: false,
          stdout: '',
          stderr: error.message,
          exitCode: null
        });
      });
    });
  }

  /**
   * Execute a project test action (typed mapping from project config).
   */
  async test(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> {
    return this.exec(options, cwd, injectedEnv);
  }

  /**
   * Execute a project lint action (typed mapping from project config).
   */
  async lint(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> {
    return this.exec(options, cwd, injectedEnv);
  }

  /**
   * Execute a project typecheck action (typed mapping from project config).
   */
  async typecheck(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> {
    return this.exec(options, cwd, injectedEnv);
  }

  /**
   * Execute a project build action (typed mapping from project config).
   */
  async build(options: ExecOptions, cwd: string, injectedEnv?: Record<string, string>): Promise<ExecResult> {
    return this.exec(options, cwd, injectedEnv);
  }
}
