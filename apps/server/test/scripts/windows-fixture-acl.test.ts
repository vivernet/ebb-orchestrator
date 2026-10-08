import { describe, expect, it, vi } from "vitest";
import { makeWindowsFixturePrivate } from "../../scripts/windows-fixture-acl.mjs";

type FixtureSpawnSync = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    encoding: "utf8";
    shell: false;
    timeout: number;
    windowsHide: true;
    maxBuffer: number;
  },
) => {
  error: NodeJS.ErrnoException | undefined;
  status: number | null;
  stderr?: string | null;
  stdout?: string | null;
};

describe("Windows native acceptance fixture ACL setup", () => {
  it("reports only recognized static PowerShell phases when the bounded call times out", () => {
    const spawnSync = vi.fn<FixtureSpawnSync>(() => {
      const error = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
      return {
        error,
        status: null,
        stderr: "EBB_ACL_PHASE:GET_ACL_STARTED\nEBB_ACL_PHASE:UNRECOGNIZED\nC:\\test-root ACL contents must not escape",
        stdout: "EBB_ACL_PHASE:SET_ACL_STARTED\nEBB_ACL_PHASE:PRIVATE_DATA",
      };
    });

    let diagnostic: string | undefined;
    try {
      makeWindowsFixturePrivate("C:\\test-root", {
        serverDirectory: "C:\\repo\\apps\\server",
        systemRoot: "C:\\Windows",
        spawnSync,
      });
    } catch (error) {
      if (error instanceof Error) diagnostic = error.message;
    }
    expect(diagnostic).toBe("WINDOWS_FIXTURE_ACL_SETUP_TIMEOUT:30000:phases=GET_ACL_STARTED,SET_ACL_STARTED");

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 30_000, shell: false, windowsHide: true });
    const command = spawnSync.mock.calls[0]?.[1][3] ?? "";
    const phases = [
      "COMMAND_START",
      "GET_ACL_STARTED",
      "GET_ACL_COMPLETED",
      "TARGET_TYPE_STARTED",
      "TARGET_TYPE_RESOLVED",
      "SET_ACL_STARTED",
      "SET_ACL_COMPLETED",
    ].map((phase) => command.indexOf(`$phase.Invoke('${phase}')`));
    expect(phases.every((position) => position >= 0)).toBe(true);
    expect(phases).toEqual([...phases].sort((left, right) => left - right));
  });

  it("reports process-start failures separately from ACL command failures", () => {
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({
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
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 17, stderr: "ACL rejected C:\\test-root" }));

    expect(() => makeWindowsFixturePrivate("C:\\test-root", {
      serverDirectory: "C:\\repo\\apps\\server",
      systemRoot: "C:\\Windows",
      spawnSync,
    })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_FAILED:EXIT_17:ACL rejected <test-root>");
  });
});
