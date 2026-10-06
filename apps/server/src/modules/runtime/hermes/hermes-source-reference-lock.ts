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

/** Process-held reader/writer lease protecting published snapshots and pending Run bindings. */
export interface HermesSourceReferenceLease {
  assertHeld(): void;
  release(): Promise<void>;
}

/** Acquires the permanent no-follow OS reference lock using the verified native helper. */
export async function acquireHermesSourceReferenceLock(input: {
  readonly cacheRoot: string;
  readonly mode: "shared" | "exclusive";
  readonly signal?: AbortSignal;
}): Promise<HermesSourceReferenceLease> {
  if (!isAbsolute(input.cacheRoot) || input.cacheRoot.includes("\0") || input.signal?.aborted) throw referenceLockError();
  const helperPath = fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/" +
    (process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path"), import.meta.url));
  const nonce = randomUUID();
  const args = ["source-cache-reference-lock", input.cacheRoot, input.mode, nonce];
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
      if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 16 * 1024 * 1024) throw referenceLockError();
      pinned = await open(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await pinned.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 ||
          (opened.mode & 0o111) === 0 || opened.size !== before.size) throw referenceLockError();
      const bytes = await pinned.readFile();
      if (bytes.length !== opened.size || createHash("sha256").update(bytes).digest("hex") !==
          await getNativeHelperIntegrityDigest("hermesProfilePath")) throw referenceLockError();
      executable = "/proc/self/fd/3";
      argv = args;
      env = {};
    } else {
      throw referenceLockError();
    }
    if (input.signal?.aborted) throw referenceLockError();
    const child = spawn(executable, argv, {
      shell: false, windowsHide: true, env,
      stdio: pinned ? ["pipe", "pipe", "pipe", pinned.fd] : ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    return await observeReferenceLease(child, nonce, input.signal);
  } catch {
    throw referenceLockError();
  } finally {
    await pinned?.close();
  }
}

async function observeReferenceLease(
  child: ChildProcessWithoutNullStreams,
  nonce: string,
  signal: AbortSignal | undefined,
): Promise<HermesSourceReferenceLease> {
  let held = false;
  let closed = false;
  let failed = false;
  let stdout = "";
  let outputBytes = 0;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => { resolveReady = resolvePromise; rejectReady = rejectPromise; });
  const stopped = new Promise<number | null>((resolvePromise) => child.once("close", (code) => {
    closed = true;
    held = false;
    if (!stdout.endsWith("\n")) rejectReady?.(referenceLockError());
    resolvePromise(code);
  }));
  const fail = () => { failed = true; rejectReady?.(referenceLockError()); child.stdin.destroy(); };
  child.once("error", fail);
  child.stdin.once("error", fail);
  child.stdout.once("error", fail);
  child.stderr.once("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 || held) { fail(); return; }
    stdout += chunk.toString("ascii");
    if (stdout.endsWith("\n")) {
      if (stdout !== READY + "\n" && stdout !== READY + "\r\n") { fail(); return; }
      held = true;
      resolveReady?.();
    }
  });
  child.stderr.on("data", () => { outputBytes += 1; fail(); });
  const onAbort = () => fail();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(fail, ACQUIRE_TIMEOUT_MS);
  try {
    await ready;
    if (!held || failed || closed || signal?.aborted) throw referenceLockError();
  } catch {
    child.stdin.destroy();
    await waitReferenceHelper(child, stopped);
    throw referenceLockError();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  let releasePromise: Promise<void> | undefined;
  return {
    assertHeld() { if (!held || closed || failed || child.exitCode !== null || child.signalCode !== null) throw referenceLockError(); },
    release() {
      releasePromise ??= (async () => {
        if (!held || closed || failed || child.exitCode !== null || child.signalCode !== null) throw referenceLockError();
        held = false;
        child.stdin.end("RELEASE " + nonce + "\n");
        const code = await waitReferenceHelper(child, stopped);
        if (failed || code !== 0) throw referenceLockError();
      })();
      return releasePromise;
    },
  };
}

async function waitReferenceHelper(child: ChildProcessWithoutNullStreams, stopped: Promise<number | null>): Promise<number | null> {
  const timer = setTimeout(() => child.kill("SIGKILL"), RELEASE_TIMEOUT_MS);
  try { return await stopped; } finally { clearTimeout(timer); }
}

function referenceLockError(): Error { return new Error("HERMES_SOURCE_REFERENCE_LOCK_UNAVAILABLE"); }
