import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

import { RepositoryDiscovery } from "../../../src/modules/projects/repository-discovery.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "repo-discovery-test-"));
}

function setupGitRepo(dir: string): void {
  execSync("git init --initial-branch=master", { cwd: dir, encoding: "utf8" });
  execSync("git config user.email test@test.com", { cwd: dir, encoding: "utf8" });
  execSync("git config user.name Test User", { cwd: dir, encoding: "utf8" });
}

describe("RepositoryDiscovery", () => {
  describe("discover", () => {
    it("returns root as the provided repo path", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      const discovery = new RepositoryDiscovery();

      const facts = await discovery.discover(tmpDir);

      expect(facts.root).toBe(resolve(tmpDir));
    });

    it("detects default branch from git", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      // Create initial commit to have a HEAD on main
      execSync("git checkout -b main", { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Test");
      execSync("git add README.md", { cwd: tmpDir });
      execSync("git commit -m init", { cwd: tmpDir });

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.defaultBranch).toBe("main");
    });

    it("detects main as default branch when it exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      execSync("git checkout -b main", { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Test");
      execSync("git add README.md", { cwd: tmpDir });
      execSync("git commit -m init", { cwd: tmpDir });

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.defaultBranch).toBe("main");
    });

    it("detects master as default branch when main doesn't exist", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      execSync("git checkout -b master", { cwd: tmpDir });
      writeFileSync(join(tmpDir, "README.md"), "# Test");
      execSync("git add README.md", { cwd: tmpDir });
      execSync("git commit -m init", { cwd: tmpDir });

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.defaultBranch).toBe("master");
    });

    it("detects remotes from git config", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      execSync("git remote add origin https://github.com/test/repo.git", { cwd: tmpDir });

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.remotes).toEqual([{ name: "origin", url: "https://github.com/test/repo.git" }]);
    });

    it("detects packageManager from package.json", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", packageManager: "pnpm@8.0.0" })
      );

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.packageManager).toBe("pnpm");
    });

    it("detects npm when package.json exists without packageManager field", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", version: "1.0.0" })
      );

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.packageManager).toBe("npm");
    });

    it("detects yarn when yarn.lock exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(join(tmpDir, "yarn.lock"), "");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.packageManager).toBe("yarn");
    });

    it("detects pnpm when pnpm-lock.yaml exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.packageManager).toBe("pnpm");
    });

    it("detects languageHints from file extensions", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      // Create tsconfig.json to trigger TypeScript detection
      writeFileSync(join(tmpDir, "tsconfig.json"), "{}");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.languageHints).toContain("typescript");
    });

    it("detects testCommands from package.json scripts", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest run" } })
      );

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.testCommands).toContain("vitest run");
    });

    it("detects vitest when vitest.config.ts exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(join(tmpDir, "vitest.config.ts"), "");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.testCommands).toContain("vitest run");
    });

    it("detects jest when jest.config.ts exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(join(tmpDir, "jest.config.ts"), "");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.testCommands).toContain("jest");
    });

    it("detects mocha when mocharc.json exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      writeFileSync(join(tmpDir, ".mocharc.json"), "{}");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.testCommands).toContain("mocha");
    });

    it("detects untrustedExistingConfig when .orchestrator/ exists", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);
      mkdirSync(join(tmpDir, ".orchestrator"));
      writeFileSync(join(tmpDir, ".orchestrator", "project.yaml"), "");

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.untrustedExistingConfig).toBe(true);
    });

    it("does not detect untrustedExistingConfig when .orchestrator/ does not exist", async () => {
      const tmpDir = createTempDir();
      setupGitRepo(tmpDir);

      const discovery = new RepositoryDiscovery();
      const facts = await discovery.discover(tmpDir);

      expect(facts.untrustedExistingConfig).toBe(false);
    });
  });
});
