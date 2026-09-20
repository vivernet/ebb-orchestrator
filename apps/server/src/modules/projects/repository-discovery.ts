import { GitCli } from "../git/git-cli.js";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export interface RepositoryFacts {
  readonly root: string;
  readonly defaultBranch: string;
  readonly remotes: readonly { name: string; url: string }[];
  readonly packageManager: string;
  readonly languageHints: readonly string[];
  readonly testCommands: readonly string[];
  readonly untrustedExistingConfig: boolean;
}

/**
 * Предоставляет публичный контракт модуля repository-discovery для взаимодействия слоёв приложения.
 */
export class RepositoryDiscovery {
  private readonly git: GitCli;

  constructor(git?: GitCli) {
    this.git = git ?? new GitCli();
  }

  async discover(repoPath: string): Promise<RepositoryFacts> {
    const root = resolve(repoPath);

    const defaultBranch = await this.detectDefaultBranch(root);
    const remotes = await this.detectRemotes(root);
    const packageManager = await this.detectPackageManager(root);
    const languageHints = this.detectLanguageHints(root);
    const testCommands = this.detectTestCommands(root);
    const untrustedExistingConfig = this.detectUntrustedExistingConfig(root);

    return {
      root,
      defaultBranch,
      remotes,
      packageManager,
      languageHints,
      testCommands,
      untrustedExistingConfig,
    };
  }

  private async detectDefaultBranch(repoPath: string): Promise<string> {
    try {
      const result = await this.git.run(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
      if (result.exitCode === 0) {
        const branch = result.stdout.trim();
        if (branch.startsWith("refs/remotes/origin/")) return branch.slice("refs/remotes/origin/".length);
      }
    } catch {
      // Fallback if no origin HEAD exists.
    }

    try {
      const result = await this.git.run(repoPath, ["branch", "--show-current"]);
      if (result.exitCode === 0) {
        const branch = result.stdout.trim();
        if (branch) return branch;
      }
    } catch {
      // Fallback to main.
    }

    try {
      const result = await this.git.run(repoPath, ["remote", "show", "origin"]);
      if (result.exitCode === 0 && result.stdout.trim()) {
        const match = /HEAD branch:\s*(\S+)/.exec(result.stdout);
        if (match?.[1]) return match[1];
      }
    } catch {
      // Fallback to main.
    }

    return "main";
  }

  private async detectRemotes(repoPath: string): Promise<{ name: string; url: string }[]> {
    try {
      const result = await this.git.run(repoPath, ["remote", "-v"]);
      if (result.exitCode !== 0) return [];

      const remotes: { name: string; url: string }[] = [];
      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      const seen = new Set<string>();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0]!;
          const url = parts[1]!;
          if (!seen.has(name)) {
            seen.add(name);
            remotes.push({ name, url });
          }
        }
      }

      return remotes;
    } catch {
      return [];
    }
  }

  private async detectPackageManager(repoPath: string): Promise<string> {
    const packageJsonPath = join(repoPath, "package.json");

    try {
      if (existsSync(packageJsonPath)) {
        const content = readFileSync(packageJsonPath, "utf8");
        const pkg = JSON.parse(content);

        if (pkg.packageManager) {
          const match = pkg.packageManager.match(/^([a-z]+)/);
          if (match) return match[1];
        }
      }
    } catch {
      // Fall through to file-based detection
    }

    const lockFiles = [
      { file: "pnpm-lock.yaml", name: "pnpm" },
      { file: "yarn.lock", name: "yarn" },
      { file: "package-lock.json", name: "npm" },
    ];

    for (const { file, name } of lockFiles) {
      if (existsSync(join(repoPath, file))) {
        return name;
      }
    }

    return "npm";
  }

  private detectLanguageHints(repoPath: string): string[] {
    const hints: Set<string> = new Set();

    try {
      const tsFiles = [
        join(repoPath, "tsconfig.json"),
        join(repoPath, "src", "index.ts"),
        join(repoPath, "lib", "index.ts"),
      ];

      for (const file of tsFiles) {
        if (existsSync(file)) {
          hints.add("typescript");
          break;
        }
      }

      const babelFiles = [
        join(repoPath, "babel.config.js"),
        join(repoPath, ".babelrc"),
      ];

      for (const file of babelFiles) {
        if (existsSync(file)) {
          hints.add("babel");
          break;
        }
      }

      const webpackFiles = [
        join(repoPath, "webpack.config.js"),
        join(repoPath, "webpack.config.ts"),
      ];

      for (const file of webpackFiles) {
        if (existsSync(file)) {
          hints.add("webpack");
          break;
        }
      }

      const viteFiles = [
        join(repoPath, "vite.config.js"),
        join(repoPath, "vite.config.ts"),
      ];

      for (const file of viteFiles) {
        if (existsSync(file)) {
          hints.add("vite");
          break;
        }
      }
    } catch {
      // Ignore errors in file detection
    }

    return Array.from(hints);
  }

  private detectTestCommands(repoPath: string): string[] {
    const commands: string[] = [];

    try {
      const packageJsonPath = join(repoPath, "package.json");

      if (existsSync(packageJsonPath)) {
        const content = readFileSync(packageJsonPath, "utf8");
        const pkg = JSON.parse(content);

        if (pkg.scripts?.test) {
          commands.push(pkg.scripts.test);
        }
      }

      if (existsSync(join(repoPath, "vitest.config.ts"))) {
        if (!commands.includes("vitest run")) {
          commands.push("vitest run");
        }
      }

      if (existsSync(join(repoPath, "vitest.config.js"))) {
        if (!commands.includes("vitest run")) {
          commands.push("vitest run");
        }
      }

      if (existsSync(join(repoPath, "jest.config.ts")) || existsSync(join(repoPath, "jest.config.js"))) {
        if (!commands.includes("jest")) {
          commands.push("jest");
        }
      }

      if (existsSync(join(repoPath, ".mocharc.json")) || existsSync(join(repoPath, ".mocharc.js"))) {
        if (!commands.includes("mocha")) {
          commands.push("mocha");
        }
      }
    } catch {
      // Ignore errors
    }

    return commands;
  }

  private detectUntrustedExistingConfig(repoPath: string): boolean {
    return existsSync(join(repoPath, ".orchestrator"));
  }
}
