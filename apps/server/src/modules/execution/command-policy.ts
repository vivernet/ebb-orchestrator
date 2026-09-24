import * as path from 'node:path';

export type CommandPolicyConfig = {
  allowedExecutables: string[];
  maxTimeout?: number;
  maxOutput?: number;
};

export type ValidationInput = {
  executable?: string;
  args?: unknown[];
  timeout?: number;
  maxOutput?: number;
  path?: string;
  cwd?: string;
};

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

export type ExecOptions = {
  executable: string;
  args: string[];
  timeout?: number;
  maxOutput?: number;
};

/**
 * Policy для валидации и классификации command execution.
 * Предотвращает RCE и path escape через:
 * - allowlisted executables
 * - typed arguments (string-only)
 * - path containment (workspace-bound)
 * - timeout и output limits
 */
export class CommandPolicy {
  private readonly allowedExecutables: Set<string>;
  private readonly maxTimeout: number;
  private readonly maxOutput: number;

  constructor(config: CommandPolicyConfig) {
    this.allowedExecutables = new Set(
      config.allowedExecutables?.map(e => e.toLowerCase()) ?? []
    );
    this.maxTimeout = config.maxTimeout ?? 300000;
    this.maxOutput = config.maxOutput ?? 10485760;
  }

  isExecutableAllowed(executable: string): boolean {
    const baseName = path.basename(executable.toLowerCase()).replace(/\.exe$/, '');
    return this.allowedExecutables.has(baseName);
  }

  validateArgs(args: unknown[]): ValidationResult {
    for (const arg of args) {
      if (typeof arg !== 'string') {
        return { valid: false, error: 'All arguments must be strings' };
      }
    }
    return { valid: true };
  }

  validatePath(candidatePath: string, cwd: string): ValidationResult {
    const fullPath = path.resolve(cwd, candidatePath);
    const normalizedPath = path.normalize(fullPath);
    const normalizedCwd = path.normalize(cwd);

    if (!normalizedPath.startsWith(normalizedCwd + path.sep) && normalizedPath !== normalizedCwd) {
      return { valid: false, error: 'Path is outside the workspace' };
    }

    return { valid: true };
  }

  validateOptions(options: Partial<ExecOptions>): ValidationResult {
    if (options.timeout !== undefined && options.timeout > this.maxTimeout) {
      return { valid: false, error: `Timeout exceeds maximum allowed (${this.maxTimeout}ms)` };
    }

    if (options.maxOutput !== undefined && options.maxOutput > this.maxOutput) {
      return { valid: false, error: `Output size exceeds maximum allowed (${this.maxOutput} bytes)` };
    }

    return { valid: true };
  }

  validateExecOptions(options: ExecOptions): ValidationResult {
    // Check executable allowlist
    if (!this.isExecutableAllowed(options.executable)) {
      return { valid: false, error: `Executable '${options.executable}' is not allowed` };
    }

    // Validate arguments
    const argsValidation = this.validateArgs(options.args);
    if (!argsValidation.valid) {
      return argsValidation;
    }

    // Validate options (timeout, maxOutput)
    const optionsValidation = this.validateOptions(options);
    if (!optionsValidation.valid) {
      return optionsValidation;
    }

    return { valid: true };
  }
}
