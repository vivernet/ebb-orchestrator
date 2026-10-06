import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getNativeHelperIntegrityDigest } from "../../../platform/process/native-helper-integrity.js";
import { createWindowsNativeHelperInvocation } from "../../../platform/process/windows-native-helper-launcher.js";

const READY = "SOURCE_CACHE_LOCK_READY";
const ACQUIRE_TIMEOUT_MS = 60_000;
const RELEASE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024;

/**
 * ОС lease сериализует cache mutations. Durable native reservation сохраняет Node owner identity
 * после смерти helper; пока Node жив, новые acquisitions fail-closed до его завершения/restart.
 */
export interface HermesSourcePublicationLease {
  /** Запрещает продолжение mutation после потери native authority. */
  assertHeld(): void;
  /** Передаёт точный RELEASE nonce после завершённых writes и ждёт exit; повторный вызов idempotent. */
  release(): Promise<void>;
}

/** Trusted internal seam: production использует verified native helper, unit fixtures задают свой lease. */
export type HermesSourcePublicationLock = (input: {
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
}) => Promise<HermesSourcePublicationLease>;

/**
 * Захватывает process-held LockFileEx/flock на постоянном приватном cache lock file.
 * Helper запускается только через pinned descriptor либо Windows integrity gate. Отсутствие
 * authority, timeout, отмена acquisition и malformed output всегда fail-closed; PID/TTL fallback нет.
 * После READY cancellation принадлежит владельцу операции: он завершает mutation и вызывает release.
 *
 * @param input Проверенный приватный cache root и необязательная отмена ожидания.
 * @param input.cacheRoot Абсолютный Orchestrator-managed source cache root.
 * @param input.signal Отменяет только acquisition до получения lease.
 * @returns Lease, удерживаемый через publication, alias recovery и final readback.
 * @throws {Error} Если нельзя доказать native helper integrity или exclusive authority.
 */
export async function acquireHermesSourcePublicationLock(input: {
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
}): Promise<HermesSourcePublicationLease> {
  if (!isAbsolute(input.cacheRoot) || input.cacheRoot.includes("\0") || input.signal?.aborted) throw lockError();
  const helperPath = fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/" +
    (process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path"), import.meta.url));
  const nonce = randomUUID();
  const args = ["source-cache-lock", input.cacheRoot, String(process.pid), nonce];
  let executable: string;
  let argv: string[];
  let env: NodeJS.ProcessEnv;
  let pinned: FileHandle | undefined;
  try {
    if (process.platform === "win32") {
      const invocation = await createWindowsNativeHelperInvocation(helperPath, "hermesProfilePath", args);
      executable = invocation.file;
      argv = [...invocation.args];
      env = { ...invocation.env };
    } else if (process.platform === "linux") {
      const before = await lstat(helperPath);
      if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 16 * 1024 * 1024) throw lockError();
      pinned = await open(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await pinned.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev ||
          opened.nlink !== 1 || (opened.mode & 0o111) === 0 || opened.size !== before.size) throw lockError();
      const bytes = await pinned.readFile();
      if (bytes.length !== opened.size || createHash("sha256").update(bytes).digest("hex") !==
          await getNativeHelperIntegrityDigest("hermesProfilePath")) throw lockError();
      executable = "/proc/self/fd/3";
      argv = args;
      env = {};
    } else {
      throw lockError();
    }
    if (input.signal?.aborted) throw lockError();
    const child = spawn(executable, argv, {
      shell: false, windowsHide: true, env,
      stdio: pinned ? ["pipe", "pipe", "pipe", pinned.fd] : ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    return await observeLease(child, nonce, input.signal);
  } catch {
    throw lockError();
  } finally {
    await pinned?.close();
  }
}

async function observeLease(child: ChildProcessWithoutNullStreams, nonce: string, signal: AbortSignal | undefined): Promise<HermesSourcePublicationLease> {
  let held = false;
  let closed = false;
  let failed = false;
  let stdout = "";
  let outputBytes = 0;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  const stopped = new Promise<number | null>((resolvePromise) => {
    child.once("close", (code) => {
      closed = true;
      held = false;
      if (!stdout.endsWith("\n")) rejectReady?.(lockError());
      resolvePromise(code);
    });
  });
  const fail = () => {
    failed = true;
    rejectReady?.(lockError());
    child.stdin.destroy();
  };
  child.once("error", fail);
  child.stdin.once("error", fail);
  child.stdout.once("error", fail);
  child.stderr.once("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES || held) { fail(); return; }
    stdout += chunk.toString("ascii");
    if (stdout.endsWith("\n")) {
      if (stdout !== READY + "\n" && stdout !== READY + "\r\n") { fail(); return; }
      held = true;
      resolveReady?.();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { outputBytes += chunk.length; fail(); });
  const onAbort = () => fail();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(fail, ACQUIRE_TIMEOUT_MS);
  try {
    await ready;
    if (!held || failed || closed || signal?.aborted) throw lockError();
  } catch {
    child.stdin.destroy();
    await waitStopped(child, stopped);
    throw lockError();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  let releasePromise: Promise<void> | undefined;
  return {
    assertHeld() { if (!held || closed || failed || child.exitCode !== null || child.signalCode !== null) throw lockError(); },
    release() {
      releasePromise ??= (async () => {
        if (!held || closed || failed || child.exitCode !== null || child.signalCode !== null) throw lockError();
        held = false;
        child.stdin.end("RELEASE " + nonce + "\n");
        const code = await waitStopped(child, stopped);
        if (failed || code !== 0) throw lockError();
      })();
      return releasePromise;
    },
  };
}

async function waitStopped(child: ChildProcessWithoutNullStreams, stopped: Promise<number | null>): Promise<number | null> {
  const timer = setTimeout(() => child.kill("SIGKILL"), RELEASE_TIMEOUT_MS);
  try { return await stopped; } finally { clearTimeout(timer); }
}

function lockError(): Error { return new Error("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE"); }
