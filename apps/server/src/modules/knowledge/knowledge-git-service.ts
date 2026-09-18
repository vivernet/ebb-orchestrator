/**
 * Knowledge Git Service – writes approved knowledge changes atomically
 * to repository Markdown files and commits them as managed Git commits.
 *
 * Commit message format: `orchestrator: update guideline GL-ARCH-014`
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────

export interface KnowledgeChange {
  /** Type of knowledge item. */
  type: "guideline" | "decision";
  /** Display ID (e.g. GL-ARCH-014, DEC-0001). */
  displayId: string;
  /** Full Markdown content (front matter + body). */
  markdown: string;
  /** Relative path within the repo (e.g. guidelines/GL-ARCH-014.md). */
  filePath: string;
}

export interface CommitResult {
  /** The git commit SHA. */
  commitSha: string;
  /** The commit message used. */
  commitMessage: string;
  /** Files that were written and committed. */
  filesChanged: string[];
}

// ── Service ─────────────────────────────────────────────────────────

/**
 * Предоставляет публичный контракт модуля knowledge-git-service для взаимодействия слоёв приложения.
 */
export class KnowledgeGitService {
  /**
   * Write approved knowledge changes to disk and commit them atomically.
   *
   * All changes in a batch are committed together in a single Git commit
   * with the standard orchestrator commit message format.
   */
  async commitChanges(repoDir: string, changes: KnowledgeChange[]): Promise<CommitResult> {
    if (changes.length === 0) {
      throw new Error("No changes to commit.");
    }

    // Write all files atomically
    const filesChanged: string[] = [];
    for (const change of changes) {
      const fullPath = join(repoDir, change.filePath);
      // Ensure parent directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, change.markdown, "utf8");
      filesChanged.push(change.filePath);
    }

    // Generate commit message
    const commitMessage = this.buildCommitMessage(changes);

    // Git add + commit
    await this.gitAdd(repoDir, filesChanged);
    const commitSha = await this.gitCommit(repoDir, commitMessage);

    return { commitSha, commitMessage, filesChanged };
  }

  /**
   * Build the commit message following the orchestrator convention.
   *
   * Single change: `orchestrator: update guideline GL-ARCH-014`
   * Multiple changes: `orchestrator: update 3 knowledge items`
   */
  buildCommitMessage(changes: KnowledgeChange[]): string {
    if (changes.length === 1) {
      const change = changes[0]!;
      return `orchestrator: update ${change.type} ${change.displayId}`;
    }
    return `orchestrator: update ${changes.length} knowledge items`;
  }

  // ── Git operations ────────────────────────────────────────────────

  private async gitAdd(repoDir: string, files: string[]): Promise<void> {
    await execFileAsync("git", ["add", ...files], { cwd: repoDir });
  }

  private async gitCommit(repoDir: string, message: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["commit", "-m", message, "--allow-empty"],
      { cwd: repoDir },
    );
    // Extract commit SHA from output: "[main abc1234] message"
    const match = stdout.match(/\b([0-9a-f]{7,40})\b/);
    if (!match) {
      // Fallback: use git rev-parse HEAD
      const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      return sha.trim();
    }
    return match[1]!;
  }
}
