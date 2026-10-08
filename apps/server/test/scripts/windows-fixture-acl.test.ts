import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeTargets() {
  const root = mkdtempSync(join(tmpdir(), "ebb-windows-acl-test-"));
  const directory = join(root, "directory");
  const file = join(root, "file.txt");
  mkdirSync(directory);
  writeFileSync(file, "fixture");
  return {
    root,
    directory,
    file,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Windows native acceptance fixture ACL setup", () => {
  it("classifies files and directories in Node without PowerShell Get-Item", () => {
    const targets = makeTargets();
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 0, stderr: "" }));
    try {
      makeWindowsFixturePrivate(targets.directory, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemRoot: "C:\\Windows",
        spawnSync,
      });
      makeWindowsFixturePrivate(targets.file, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemRoot: "C:\\Windows",
        spawnSync,
      });

      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(spawnSync.mock.calls.map((call) => call[2].env.EBB_HERMES_PROFILE_TEST_IS_DIRECTORY)).toEqual(["1", "0"]);
      for (const call of spawnSync.mock.calls) {
        const command = call[1][3] ?? "";
        expect(command).not.toMatch(/Get-Item/u);
        expect(command).toContain("EBB_HERMES_PROFILE_TEST_IS_DIRECTORY");
      }
    } finally {
      targets.cleanup();
    }
  });

  it("rejects a symlink before starting PowerShell", () => {
    const targets = makeTargets();
    const symlink = join(targets.root, "directory-link");
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 0, stderr: "" }));
    try {
      symlinkSync(targets.directory, symlink, process.platform === "win32" ? "junction" : "dir");
      expect(() => makeWindowsFixturePrivate(symlink, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemRoot: "C:\\Windows",
        spawnSync,
      })).toThrow("WINDOWS_FIXTURE_ACL_UNSAFE_TARGET");
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      targets.cleanup();
    }
  });

  it("reports only recognized static PowerShell phases when the bounded call times out", () => {
    const targets = makeTargets();
    const spawnSync = vi.fn<FixtureSpawnSync>(() => {
      const error = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
      return {
        error,
        status: null,
        stderr: "EBB_ACL_PHASE:GET_ACL_STARTED\nEBB_ACL_PHASE:UNRECOGNIZED\nC:\\test-root ACL contents must not escape",
        stdout: "EBB_ACL_PHASE:SET_ACL_STARTED\nEBB_ACL_PHASE:PRIVATE_DATA",
      };
    });

    try {
      let diagnostic: string | undefined;
      try {
        makeWindowsFixturePrivate(targets.directory, {
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
      expect(spawnSync.mock.calls[0]?.[2].env.EBB_HERMES_PROFILE_TEST_IS_DIRECTORY).toBe("1");
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
    } finally {
      targets.cleanup();
    }
  });

  it("reports process-start failures separately from ACL command failures", () => {
    const targets = makeTargets();
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({
      error: Object.assign(new Error("spawnSync powershell.exe EACCES"), { code: "EACCES" }),
      status: null,
      stderr: "",
    }));

    try {
      expect(() => makeWindowsFixturePrivate(targets.file, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemRoot: "C:\\Windows",
        spawnSync,
      })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_SPAWN_FAILED:EACCES");
      expect(spawnSync.mock.calls[0]?.[2].env.EBB_HERMES_PROFILE_TEST_IS_DIRECTORY).toBe("0");
    } finally {
      targets.cleanup();
    }
  });

  it("fails closed when PowerShell exits unsuccessfully and reports sanitized stderr", () => {
    const targets = makeTargets();
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 17, stderr: `ACL rejected ${targets.directory}` }));

    try {
      expect(() => makeWindowsFixturePrivate(targets.directory, {
      serverDirectory: "C:\\repo\\apps\\server",
      systemRoot: "C:\\Windows",
      spawnSync,
      })).toThrow("WINDOWS_FIXTURE_ACL_SETUP_FAILED:EXIT_17:ACL rejected <test-root>");
    } finally {
      targets.cleanup();
    }
  });
});
