import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
  const digest = await getNativeHelperIntegrityDigest(anchorName);
  const pathStat = await lstat(helperPath).catch(() => { throw new Error("NATIVE_HELPER_UNAVAILABLE"); });
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || (pathStat.mode & 0o111) === 0) {
    throw new Error("NATIVE_HELPER_PATH_UNSAFE");
  }
  let helper;
  try {
    helper = await open(helperPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error("NATIVE_HELPER_UNAVAILABLE");
  }
  try {
    const details = await helper.stat();
    if (!details.isFile() || (details.mode & 0o111) === 0) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
    const bytes = await helper.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("NATIVE_HELPER_INTEGRITY_MISMATCH");
    }
    return await spawnPinnedDescriptor(helper.fd, args, options);
  } finally {
    await helper.close().catch(() => undefined);
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
      stdio: ["ignore", "pipe", "pipe", fileDescriptor],
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
