import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type NativeHelperAnchorName = "windowsRunSupervisor" | "hermesProfilePath";
type NativeHelperAnchorKey = NativeHelperAnchorName | "linuxHermesLauncher";

/** Loads only the expected digest from generated parent-runtime code, never from helper output. */
export async function getNativeHelperIntegrityDigest(anchorName: NativeHelperAnchorName): Promise<string> {
  return loadNativeHelperIntegrityDigest(anchorName);
}

/** Loads the Linux Hermes launcher digest from the generated parent-runtime anchor. */
export async function getLinuxHermesLauncherIntegrityDigest(): Promise<string> {
  return loadNativeHelperIntegrityDigest("linuxHermesLauncher");
}

async function loadNativeHelperIntegrityDigest(anchorName: NativeHelperAnchorKey): Promise<string> {
  const anchorPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/platform/process/native-helper-integrity-anchor.js");
  let anchorModule: unknown;
  try {
    anchorModule = await import(pathToFileURL(anchorPath).href) as unknown;
  } catch {
    throw new Error("NATIVE_HELPER_INTEGRITY_ANCHOR_UNAVAILABLE");
  }
  return readAnchorDigest(anchorModule, anchorName);
}

/**
 * Verifies a packaged native helper against SHA-256 embedded in the generated parent-code asset.
 * The expected digest is loaded from `dist/platform/process`, outside the helper output directory;
 * no helper response or adjacent mutable JSON manifest contributes to the trust decision.
 *
 * @param helperPath Absolute helper executable path.
 * @param anchorName Key selected from the parent-code integrity anchor.
 * @throws {Error} If the anchor is absent, the path is not a regular file, or bytes differ.
 */
export async function verifyNativeHelperIntegrity(
  helperPath: string,
  anchorName: NativeHelperAnchorName,
): Promise<void> {
  if (!path.isAbsolute(helperPath)) throw new Error("NATIVE_HELPER_PATH_INVALID");
  const digest = await getNativeHelperIntegrityDigest(anchorName);
  const details = await lstat(helperPath).catch(() => { throw new Error("NATIVE_HELPER_UNAVAILABLE"); });
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
  const canonical = await realpath(helperPath).catch(() => { throw new Error("NATIVE_HELPER_PATH_UNSAFE"); });
  if (!samePath(canonical, helperPath)) throw new Error("NATIVE_HELPER_PATH_UNSAFE");
  const bytes = await readFile(helperPath).catch(() => { throw new Error("NATIVE_HELPER_UNAVAILABLE"); });
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) throw new Error("NATIVE_HELPER_INTEGRITY_MISMATCH");
}

/** Compares arbitrary helper bytes with an independently supplied expected SHA-256 digest. */
export function nativeHelperBytesMatchDigest(bytes: Uint8Array, expectedDigest: string): boolean {
  return /^[a-f0-9]{64}$/u.test(expectedDigest) &&
    createHash("sha256").update(bytes).digest("hex") === expectedDigest;
}

function readAnchorDigest(anchor: unknown, key: NativeHelperAnchorKey): string {
  if (typeof anchor !== "object" || anchor === null || !("NATIVE_HELPER_INTEGRITY_ANCHOR" in anchor)) {
    throw new Error("NATIVE_HELPER_INTEGRITY_ANCHOR_INVALID");
  }
  const values = (anchor as { NATIVE_HELPER_INTEGRITY_ANCHOR?: unknown }).NATIVE_HELPER_INTEGRITY_ANCHOR;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("NATIVE_HELPER_INTEGRITY_ANCHOR_INVALID");
  }
  const digest = (values as Record<string, unknown>)[key];
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("NATIVE_HELPER_INTEGRITY_ANCHOR_UNAVAILABLE");
  }
  return digest;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.win32.normalize(left).toLocaleLowerCase("en-US") === path.win32.normalize(right).toLocaleLowerCase("en-US")
    : path.posix.normalize(left) === path.posix.normalize(right);
}
