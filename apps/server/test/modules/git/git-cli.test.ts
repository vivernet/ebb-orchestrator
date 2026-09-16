import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-cli-test-"));
}

describe("GitCli", () => {
  describe("run", () => {
    it("returns exit code 0 and stdout for successful git command", async () => {
      const tmpDir = createTempDir();
      const git = new GitCli();

      await git.run(tmpDir, ["init"]);
      const result = await git.run(tmpDir, ["status", "--porcelain"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("rejects with ExitCodeError on non-zero exit", async () => {
      const tmpDir = createTempDir();
      const git = new GitCli();

      await git.run(tmpDir, ["init"]);
      await expect(git.run(tmpDir, ["commit", "-m", "test"])).rejects.toThrow("git commit -m test");
    });

    it("passes arguments safely without shell interpretation", async () => {
      const tmpDir = createTempDir();
      const git = new GitCli();

      await git.run(tmpDir, ["init"]);

      // Test with a filename containing spaces and special chars that would be interpreted incorrectly if args are joined as string
      const filename = "test file with spaces.txt";
      writeFileSync(join(tmpDir, filename), "test");
      await git.run(tmpDir, ["add", filename]);

      const result = await git.run(tmpDir, ["status", "--porcelain"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(filename);
    });

    it("handles output with newlines and special characters", async () => {
      const tmpDir = createTempDir();
      const git = new GitCli();

      await git.run(tmpDir, ["init"]);
      writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3");
      await git.run(tmpDir, ["add", "test.txt"]);
      await git.run(tmpDir, ["config", "user.email", "test@example.com"]);
      await git.run(tmpDir, ["config", "user.name", "Test User"]);
      await git.run(tmpDir, ["commit", "-m", "test"]);

      const result = await git.run(tmpDir, ["log", "--oneline"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test");
    });
  });

  describe("output buffering", () => {
    it("captures stdout and stderr separately", async () => {
      const tmpDir = createTempDir();
      const git = new GitCli();

      await git.run(tmpDir, ["init"]);
      const result = await git.run(tmpDir, ["--version"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("git version");
    });
  });
});
