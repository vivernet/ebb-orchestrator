import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { Readable, Writable } from "node:stream";

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  /** Optional caller-bounded payload sent to child stdin; the stream is closed after the payload. */
  input?: string;
}

export interface ProcessSessionOptions extends Omit<ProcessOptions, "input"> {
  /** Leaves streaming listeners active but omits child output from the resolved result. */
  captureOutput?: boolean;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessSession {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<ProcessResult>;
  terminate(): void;
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
   * Запускает shell-free процесс с потоками для OS-supervisor протокола.
   * Caller владеет остановкой внешней service/Job scope: `terminate` закрывает только launcher process.
   *
   * @param file Executable, передаваемый напрямую в spawn.
   * @param args Аргументы без shell parsing.
   * @param options Ограниченное environment, cwd и необязательные timeout/abort параметры.
   * @returns Потоки launch protocol и Promise результата после закрытия launcher.
   * @throws {Error} При abort, превышении deadline/output buffer или ошибке запуска.
   */
  startSession(file: string, args: string[], options: ProcessSessionOptions = {}): ProcessSession {
    const { cwd, env, timeout = 0, signal, maxBuffer = 10 * 1024 * 1024, captureOutput = true } = options;
    const resolvedFile = process.platform === "win32" && !file.includes(".") ? `${file}.exe` : file;
    if (signal?.aborted) throw new Error("Process aborted before spawn");
    const child = spawn(resolvedFile, args, {
      shell: false,
      cwd,
      env: env ?? buildMinimalEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    const append = (current: string, chunk: Buffer, currentBytes: number): string => {
      const remaining = Math.max(0, maxBuffer - currentBytes);
      if (chunk.byteLength > remaining) exceeded = true;
      return current + chunk.subarray(0, remaining).toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (captureOutput) stdout = append(stdout, chunk, stdoutBytes);
      else if (chunk.byteLength > Math.max(0, maxBuffer - stdoutBytes)) exceeded = true;
      stdoutBytes += chunk.byteLength;
      if (exceeded) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (captureOutput) stderr = append(stderr, chunk, stderrBytes);
      else if (chunk.byteLength > Math.max(0, maxBuffer - stderrBytes)) exceeded = true;
      stderrBytes += chunk.byteLength;
      if (exceeded) child.kill("SIGKILL");
    });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("close", (code) => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) { reject(new Error("Process aborted")); return; }
        if (timedOut) { reject(new Error(`Process timed out after ${timeout}ms`)); return; }
        if (exceeded) { reject(new Error("output buffer exceeded")); return; }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      completion,
      terminate: () => { child.kill("SIGKILL"); },
    };
  }

  /**
   * Безопасно запускает процесс с shell: false, предотвращая shell injection.
   * Использует ограниченные буферы вывода и поддерживает явную отмену через AbortSignal.
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
      input,
    } = options;

    // На Windows добавляем .exe если расширение отсутствует
    const resolvedFile = process.platform === 'win32' && !file.includes('.') ? `${file}.exe` : file;
    const childEnv = env ?? buildMinimalEnvironment();

    if (signal?.aborted) {
      throw new Error('Process aborted before spawn');
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(resolvedFile, args, {
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
      let inputError: Error | undefined;
      if (input !== undefined && child.stdin) {
        child.stdin.on("error", (error: Error) => { inputError = error; });
        child.stdin.end(input);
      }

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
        if (inputError) {
          reject(new Error("Process stdin input failed"));
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
