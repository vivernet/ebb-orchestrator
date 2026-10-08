import { describe, expect, it, vi } from "vitest";
import { makeWindowsFixturePrivate } from "../../scripts/windows-fixture-acl.mjs";

describe("Windows native acceptance fixture ACL setup", () => {
  it("uses a bounded 30-second PowerShell timeout and reports timeout separately without retrying", () => {
    const spawnSync = vi.fn(() => {
      const error = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
      return { error, status: null, stderr: "" };
    });

    expect(() => makeWindowsFixturePrivate("C:\\test-root", {
      serverDirectory: "C:\\repo\\apps\\server",
      systemRoot: "C:\\Windows",
      spawnSync,
    })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_TIMEOUT:30000");

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 30_000, shell: false, windowsHide: true });
  });

  it("reports process-start failures separately from ACL command failures", () => {
    const spawnSync = vi.fn(() => ({
      error: Object.assign(new Error("spawnSync powershell.exe EACCES"), { code: "EACCES" }),
      status: null,
      stderr: "",
    }));

    expect(() => makeWindowsFixturePrivate("C:\\test-root", {
      serverDirectory: "C:\\repo\\apps\\server",
      systemRoot: "C:\\Windows",
      spawnSync,
    })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_SPAWN_FAILED:EACCES");
  });

  it("fails closed when PowerShell exits unsuccessfully and reports sanitized stderr", () => {
    const spawnSync = vi.fn(() => ({ error: undefined, status: 17, stderr: "ACL rejected C:\\test-root" }));

    expect(() => makeWindowsFixturePrivate("C:\\test-root", {
      serverDirectory: "C:\\repo\\apps\\server",
      systemRoot: "C:\\Windows",
      spawnSync,
    })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_FAILED:EXIT_17:ACL rejected <test-root>");
  });
});
