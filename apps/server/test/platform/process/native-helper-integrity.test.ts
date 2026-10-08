import { appendFile, copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyNativeHelperIntegrity } from "../../../src/platform/process/native-helper-integrity.js";
import { runVerifiedNativeHelper } from "../../../src/platform/process/native-helper-launcher.js";

const serverRoot = path.resolve(import.meta.dirname, "../../..");
const helperName = process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path";
const packagedHelper = path.join(serverRoot, "dist/native/hermes-profile-path", helperName);
const packagedWindowsSupervisor = path.join(serverRoot, "dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
const packagedAnchor = path.join(serverRoot, "dist/platform/process/native-helper-integrity-anchor.js");
const windowsSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;

describe("packaged native helper integrity", () => {
  it.skipIf(!existsSync(packagedHelper) || !existsSync(packagedAnchor))(
    "rejects Hermes profile helper bytes changed after the parent-code digest was generated",
    async () => assertTamperRejected(packagedHelper, "hermesProfilePath", helperName),
  );

  it.skipIf(!existsSync(packagedWindowsSupervisor) || !existsSync(packagedAnchor))(
    "rejects Windows supervisor helper bytes changed after the parent-code digest was generated",
    async () => assertTamperRejected(packagedWindowsSupervisor, "windowsRunSupervisor", "ebb-run-supervisor.exe"),
  );

  it.skipIf(process.platform !== "win32" || !existsSync(packagedHelper) || !existsSync(packagedAnchor) ||
    !windowsSystemRoot || !existsSync(windowsSystemRoot))(
    "executes the profile helper through the parent-hash gate for a trusted Windows directory",
    async () => {
      if (!windowsSystemRoot) throw new Error("WINDOWS_SYSTEM_ROOT_UNAVAILABLE");
      const result = await runVerifiedNativeHelper(packagedHelper, "hermesProfilePath", [
        "verify-safe-path", "directory", windowsSystemRoot,
      ], { timeout: 5_000, maxBuffer: 8_192 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"status":"SAFE_PATH"');
      expect(result.stdout).toContain('"kind":"directory"');
    },
  );

  it.skipIf(process.platform !== "win32" || !existsSync(packagedWindowsSupervisor) || !existsSync(packagedAnchor))(
    "executes the process supervisor only after a parent-hash check on its held file handle",
    async () => {
      const id = "a".repeat(64);
      const nonce = "b".repeat(64);
      const result = await runVerifiedNativeHelper(packagedWindowsSupervisor, "windowsRunSupervisor", [
        "inspect", id, nonce, "PREPARED", "-", "-", "0", "0",
      ], { timeout: 5_000, maxBuffer: 8_192 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("STOPPED\tOWNER_NEVER_LAUNCHED");

      const attempted = await runVerifiedNativeHelper(packagedWindowsSupervisor, "windowsRunSupervisor", [
        "inspect", id, nonce, "PREPARED", "-", "-", "0", "1",
      ], { timeout: 5_000, maxBuffer: 8_192 });
      expect(attempted.exitCode).toBe(0);
      expect(attempted.stdout).toContain("STOPPED\tJOB_ABSENT_ATTEMPT_SETTLED");
    },
  );
});

async function assertTamperRejected(
  sourcePath: string,
  anchorName: "hermesProfilePath" | "windowsRunSupervisor",
  filename: string,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ebb-native-helper-tamper-"));
  const copiedHelper = path.join(directory, filename);
  try {
    await copyFile(sourcePath, copiedHelper);
    await expect(verifyNativeHelperIntegrity(copiedHelper, anchorName)).resolves.toBeUndefined();

    await appendFile(copiedHelper, Buffer.from("tampered"));
    await expect(verifyNativeHelperIntegrity(copiedHelper, anchorName))
      .rejects.toThrow("NATIVE_HELPER_INTEGRITY_MISMATCH");
    if (process.platform === "win32") {
      await expect(runVerifiedNativeHelper(copiedHelper, anchorName, ["tampered"], {
        timeout: 5_000,
        maxBuffer: 8_192,
      })).rejects.toThrow("NATIVE_HELPER_INTEGRITY_MISMATCH");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
