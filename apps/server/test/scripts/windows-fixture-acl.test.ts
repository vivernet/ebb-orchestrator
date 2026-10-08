import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPrivateFixtureDirectory, makeWindowsFixturePrivate } from "../../scripts/windows-fixture-acl.mjs";

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
  it("creates a direct-child fixture with an atomic protected owner-only DACL", () => {
    const directory = `C:\\ebb-hermes-fixture-${process.pid}`;
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 0, stderr: "" }));
    const created = createWindowsPrivateFixtureDirectory(directory, {
      serverDirectory: "C:\\repo\\apps\\server",
      systemPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      spawnSync,
    });

    expect(created).toBe(directory);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [executable, args, options] = spawnSync.mock.calls[0]!;
    const command = args[3] ?? "";
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(options.env.EBB_HERMES_PRIVATE_FIXTURE_ROOT).toBe(directory);
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 30_000 });
    expect(command).toContain("$directory.Create($acl)");
    expect(command).toContain("$directory.GetAccessControl()");
    expect(command).toContain("$verified.AreAccessRulesProtected");
    expect(command).toContain("$rules.Count -ne 1");
    expect(command).toContain("[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit");
    expect(command).toContain("$rules[0].InheritanceFlags -ne $inherit");
    expect(command).not.toMatch(/SetAccessControl|Set-Acl|Get-Acl/u);
  });

  it("rejects nested targets and reports failed fixture creation without leaking the path", () => {
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 9, stderr: "failure includes C:\\private\\fixture" }));
    expect(() => createWindowsPrivateFixtureDirectory("C:\\Users\\fixture", {
      serverDirectory: "C:\\repo\\apps\\server", systemPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawnSync,
    })).toThrow("WINDOWS_FIXTURE_PRIVATE_CREATE_UNSAFE_TARGET");
    for (const networkPath of ["\\\\server\\share\\fixture", "\\\\?\\UNC\\server\\share\\fixture"]) {
      expect(() => createWindowsPrivateFixtureDirectory(networkPath, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        spawnSync,
      })).toThrow("WINDOWS_FIXTURE_PRIVATE_CREATE_UNSAFE_TARGET");
    }
    expect(spawnSync).not.toHaveBeenCalled();

    const candidate = `C:\\ebb-hermes-private-fixture-${process.pid}-${Date.now()}`;
    try {
      createWindowsPrivateFixtureDirectory(candidate, {
        serverDirectory: "C:\\repo\\apps\\server", systemPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawnSync,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("WINDOWS_FIXTURE_PRIVATE_CREATE_FAILED:EXIT_9:phases=none");
      expect((error as Error).message).not.toContain(candidate);
    }
  });

  it("sanitizes lstat causes to an allowlisted code without retaining the candidate path", () => {
    const candidate = `C:\\ebb-hermes-fixture-${process.pid}-private\0path`;
    const spawnSync = vi.fn<FixtureSpawnSync>(() => ({ error: undefined, status: 0, stderr: "" }));
    let failure: Error | undefined;
    try {
      createWindowsPrivateFixtureDirectory(candidate, {
        serverDirectory: "C:\\repo\\apps\\server",
        systemPowerShellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        spawnSync,
      });
    } catch (error) {
      if (error instanceof Error) failure = error;
    }

    expect(failure?.message).toBe("WINDOWS_FIXTURE_PRIVATE_CREATE_UNSAFE_TARGET");
    const cause = failure?.cause;
    expect(cause).toBeInstanceOf(Error);
    const safeCause = cause as NodeJS.ErrnoException;
    expect(safeCause.code).toMatch(/^(?:EACCES|EBUSY|EINVAL|EIO|EISDIR|ENOENT|ENOTDIR|EPERM|UNKNOWN)$/u);
    expect(safeCause.message).toBe(`Fixture filesystem error: ${safeCause.code}`);
    expect(safeCause.stack).toBe(safeCause.message);
    expect(Object.keys(safeCause)).toEqual(["code", "name"]);
    expect(safeCause.name).toBe("Error");
    expect(`${failure?.message}\n${failure?.stack}\n${safeCause.message}\n${safeCause.stack}`)
      .not.toContain(candidate);
    expect(spawnSync).not.toHaveBeenCalled();
  });

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
        expect(command).not.toMatch(/Get-Acl|Set-Acl/u);
        expect(command).toContain("EBB_HERMES_PROFILE_TEST_IS_DIRECTORY");
        expect(command).toMatch(/if \(\$isDirectory -eq '1'\) \{ \[System\.IO\.DirectoryInfo\]::new\(\$path\) \} else \{ \[System\.IO\.FileInfo\]::new\(\$path\) \}/u);
        expect(command).toContain("$acl = $item.GetAccessControl();");
        expect(command).toContain("$item.SetAccessControl($acl);");
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
        "TARGET_TYPE_STARTED",
        "TARGET_TYPE_RESOLVED",
        "GET_ACL_STARTED",
        "GET_ACL_COMPLETED",
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
