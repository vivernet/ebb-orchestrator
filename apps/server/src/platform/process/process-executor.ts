import { spawn } from "child_process";

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Предоставляет публичный контракт модуля process-executor для взаимодействия слоёв приложения.
 */
export class ExitCodeError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(`Command exited with code ${exitCode}: ${command}`);
    this.name = "ExitCodeError";
  }
}

/**
 * Предоставляет публичный контракт модуля process-executor для взаимодействия слоёв приложения.
 */
export class ProcessExecutor {
  /**
   * Executes a process safely with shell: false to prevent shell injection.
   * Uses bounded output buffers and supports explicit cancellation via AbortSignal.
   */
  async exec(
    file: string,
    args: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    const {
      cwd,
      env,
      timeout = 300000, // 5 minutes default
      signal,
      maxBuffer = 10 * 1024 * 1024, // 10MB default
    } = options;

    const childEnv = env ?? buildMinimalEnvironment();

    if (signal?.aborted) {
      throw new Error('Process aborted before spawn');
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(file, args, {
        shell: false,
        cwd,
        env: childEnv,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputExceeded = false;

      const cleanup = () => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      };

      const onAbort = () => {
        timedOut = true;
        cleanup();
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const onTimeout = () => {
        timedOut = true;
        cleanup();
      };

      const timeoutId = setTimeout(onTimeout, timeout);

      child.stdout?.on("data", (chunk: Buffer) => {
        const remaining = maxBuffer - stdout.length;
        stdout += chunk.toString().slice(0, Math.max(0, remaining));
        if (chunk.length > Math.max(0, remaining)) {
          outputExceeded = true;
          cleanup();
          return;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const remaining = maxBuffer - stderr.length;
        stderr += chunk.toString().slice(0, Math.max(0, remaining));
        if (chunk.length > Math.max(0, remaining)) {
          outputExceeded = true;
          cleanup();
          return;
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }

        if (timedOut) {
          reject(new Error(`Process timed out after ${timeout}ms`));
          return;
        }
        if (outputExceeded) {
          reject(new Error("output buffer exceeded"));
          return;
        }

        if (code !== 0) {
          reject(new ExitCodeError(`${file} ${args.join(" ")}`, code ?? 1, stdout, stderr));
          return;
        }

        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }
}

/** Возвращает минимальное окружение subprocess без наследования секретов. */
function buildMinimalEnvironment(): Record<string, string> {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}
