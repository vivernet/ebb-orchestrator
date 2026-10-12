import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { ExitCodeError, ProcessExecutor, type ProcessOptions, type ProcessResult } from "./process-executor.js";
import { getNativeHelperIntegrityDigest, type NativeHelperAnchorName } from "./native-helper-integrity.js";
import { createWindowsNativeHelperInvocation } from "./windows-native-helper-launcher.js";

/**
 * Launches a packaged native helper only from bytes matching a trusted parent-code anchor.
 * Windows delegates the held-handle check and process creation to the fixed SystemRoot PowerShell
 * gate; Linux execs through an inherited descriptor so path replacement cannot select another
 * file after verification. This is helper authenticity, not an OS sandbox against the same UID.
 *
 * @param helperPath Absolute packaged helper path.
 * @param anchorName Key in generated parent-code SHA anchor.
 * @param args Native helper arguments passed without shell parsing.
 * @param options Bounded process options; environment is explicitly supplied by the caller.
 * @returns Captured helper result with a bounded stdout/stderr buffer.
 * @throws {Error} If the anchor is missing, the helper object differs, or execution fails.
 */
export async function runVerifiedNativeHelper(
  helperPath: string,
  anchorName: NativeHelperAnchorName,
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  if (!path.isAbsolute(helperPath) || args.length === 0 || args.some((argument) => argument.includes("\0"))) {
    throw new Error("NATIVE_HELPER_LAUNCH_INPUT_INVALID");
  }
  if (process.platform === "win32") {
    const invocation = await createWindowsNativeHelperInvocation(helperPath, anchorName, args);
    try {
      return await new ProcessExecutor().exec(invocation.file, [...invocation.args], {
        ...options,
        env: { ...invocation.env },
        maxBuffer: options.maxBuffer ?? 8_192,
        timeout: options.timeout ?? 5_000,
      });
    } catch (error) {
      if (error instanceof ExitCodeError && error.exitCode === 127) {
        throw new Error("NATIVE_HELPER_INTEGRITY_MISMATCH", { cause: error });
      }
      if (error instanceof ExitCodeError) {
        const gateFailure = error.stderr.split(/\r?\n/u).find((line) => line.startsWith("NATIVE_HELPER_GATE_FAIL:"));
        if (gateFailure) throw new Error(gateFailure, { cause: error });
      }
      throw error;
    }
  }
  if (process.platform !== "linux") throw new Error("NATIVE_HELPER_PLATFORM_UNSUPPORTED");
  return runLinuxHelperFromDescriptor(helperPath, anchorName, args, options);
}

async function runLinuxHelperFromDescriptor(
  helperPath: string,
  anchorName: NativeHelperAnchorName,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const helper = await pinVerifiedLinuxNativeHelper(helperPath, anchorName);
  try {
    return await spawnPinnedDescriptor(helper.fd, args, options);
  } finally {
    await helper.close();
  }
}

/**
 * Внутренний Linux seam: удерживает nofollow descriptors всех родителей и проверяет bounded
 * bytes helper по first-party digest. Host owner/write bits не являются admission policy.
 * Возвращённый fd передаётся через stdio для exec; pathname больше не выбирает executable.
 * Caller обязан закрыть lease после spawn/завершения; close idempotent. Ошибки закрывают всю цепочку.
 * @param helperPath Абсолютный canonical Linux path packaged helper, максимум 64 компонента.
 * @param anchorName Trusted parent-code digest anchor.
 * @param requireSingleLink Сохраняет дополнительный single-link invariant publication lock.
 * @returns Held descriptor и освобождение цепочки без повторного native verification.
 * @throws {Error} При symlink, substitution, изменении bytes или digest mismatch.
 */
export async function pinVerifiedLinuxNativeHelper(
  helperPath: string,
  anchorName: NativeHelperAnchorName,
  requireSingleLink = false,
): Promise<{ readonly fd: number; close(): Promise<void> }> {
  const parts = helperPath.split("/").slice(1);
  if (process.platform !== "linux" || !path.posix.isAbsolute(helperPath) ||
      path.posix.normalize(helperPath) !== helperPath || [...helperPath].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      parts.length === 0 || parts.length > 64 || parts.some((part) => !part) ||
      !fsConstants.O_NOFOLLOW || !fsConstants.O_DIRECTORY) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
  const digest = await getNativeHelperIntegrityDigest(anchorName);
  const held: FileHandle[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of [...held].reverse()) await entry.close().catch(() => undefined);
  };
  try {
    held.push(await open("/", fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY));
    for (const [index, part] of parts.entries()) {
      const parent = held[held.length - 1];
      if (!parent) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
      held.push(await open(`/proc/self/fd/${parent.fd}/${part}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW |
        (index === parts.length - 1 ? fsConstants.O_NONBLOCK : fsConstants.O_DIRECTORY)));
    }
    const helper = held[held.length - 1];
    if (!helper) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
    const before = await helper.stat({ bigint: true });
    const maxBytes = 16 * 1024 * 1024;
    if (!before.isFile() || (before.mode & 0o111n) === 0n || before.size <= 0n || before.size > BigInt(maxBytes) ||
        (requireSingleLink && before.nlink !== 1n)) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await helper.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await helper.stat({ bigint: true });
    if (length !== Number(before.size) || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        (requireSingleLink && after.nlink !== 1n)) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
    if (createHash("sha256").update(buffer.subarray(0, length)).digest("hex") !== digest) {
      throw new Error("NATIVE_HELPER_INTEGRITY_MISMATCH");
    }
    for (const [index, part] of parts.entries()) {
      const parent = held[index];
      const child = held[index + 1];
      if (!parent || !child) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
      const linked = await lstat(`/proc/self/fd/${parent.fd}/${part}`, { bigint: true });
      const pinned = await child.stat({ bigint: true });
      if (linked.isSymbolicLink() || linked.dev !== pinned.dev || linked.ino !== pinned.ino ||
          (index === parts.length - 1 ? !linked.isFile() : !linked.isDirectory())) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
    }
    return { fd: helper.fd, close };
  } catch (error) {
    await close();
    if (error instanceof Error && error.message.startsWith("NATIVE_HELPER_")) throw error;
    throw new Error("NATIVE_HELPER_PATH_UNSAFE", { cause: error });
  }
}

function spawnPinnedDescriptor(
  fileDescriptor: number,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const maxBuffer = options.maxBuffer ?? 8_192;
  const timeoutMs = options.timeout ?? 5_000;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("NATIVE_HELPER_LAUNCH_OPTIONS_INVALID");
  }
  if (options.signal?.aborted) throw new Error("Process aborted before spawn");
  return new Promise((resolve, reject) => {
    const child = spawn("/proc/self/fd/3", args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe", fileDescriptor],
    });
    let inputError: Error | undefined;
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", (error: Error) => { inputError = error; });
      child.stdin.end(options.input);
    }
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputExceeded = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, maxBuffer - current.byteLength);
      if (chunk.byteLength > remaining) outputExceeded = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      reject(new Error("NATIVE_HELPER_LAUNCH_STREAM_UNAVAILABLE"));
      return;
    }
    stdoutStream.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (outputExceeded) child.kill("SIGKILL");
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      if (outputExceeded) child.kill("SIGKILL");
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new Error("NATIVE_HELPER_LAUNCH_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) { reject(new Error("Process aborted")); return; }
      if (timedOut) { reject(new Error(`Process timed out after ${timeoutMs}ms`)); return; }
      if (outputExceeded) { reject(new Error("output buffer exceeded")); return; }
      if (inputError) { reject(new Error("NATIVE_HELPER_STDIN_WRITE_FAILED")); return; }
      const result = { exitCode: code ?? 1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
      if (result.exitCode !== 0) { reject(new Error("NATIVE_HELPER_EXECUTION_FAILED")); return; }
      resolve(result);
    });
  });
}
