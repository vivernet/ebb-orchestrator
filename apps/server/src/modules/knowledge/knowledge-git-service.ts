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
  /** Тип of knowledge item. */
  type: "guideline" | "decision";
  /** Отображаемый ID (e.g. GL-ARCH-014, DEC-0001). */
  displayId: string;
  /** Полное Markdown content (front matter + body). */
  markdown: string;
  /** Относительный path within the repo (e.g. guidelines/GL-ARCH-014.md). */
  filePath: string;
}

export interface CommitResult {
  /** Этот git commit SHA. */
  commitSha: string;
  /** Этот commit message used. */
  commitMessage: string;
  /** Файлы that were written and committed. */
  filesChanged: string[];
}

// ── Service ─────────────────────────────────────────────────────────

/**
 * Предоставляет публичный контракт модуля knowledge-git-service для взаимодействия слоёв приложения.
 */
export class KnowledgeGitService {
  /**
   * Записывает approved knowledge changes to disk and commit them atomically.
   *
   * Все changes in a batch are committed together in a single Git commit
   * with the standard orchestrator commit message format.
   */
  async commitChanges(repoDir: string, changes: KnowledgeChange[]): Promise<CommitResult> {
    if (changes.length === 0) {
      throw new Error("No changes to commit.");
    }

    // Записывает all files atomically
    const filesChanged: string[] = [];
    for (const change of changes) {
      const fullPath = join(repoDir, change.filePath);
      // Обеспечивает parent directory exists
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, change.markdown, "utf8");
      filesChanged.push(change.filePath);
    }

    // Формирует commit message
    const commitMessage = this.buildCommitMessage(changes);

    // Git add + commit
    await this.gitAdd(repoDir, filesChanged);
    const commitSha = await this.gitCommit(repoDir, commitMessage);

    return { commitSha, commitMessage, filesChanged };
  }

  /**
   * Формирует the commit message following the orchestrator convention.
   *
   * Одиночное change: `orchestrator: update guideline GL-ARCH-014`
   * Несколько changes: `orchestrator: update 3 knowledge items`
   */
  buildCommitMessage(changes: KnowledgeChange[]): string {
    if (changes.length === 1) {
      const change = changes[0]!;
      return `orchestrator: update ${change.type} ${change.displayId}`;
    }
    return `orchestrator: update ${changes.length} knowledge items`;
  }

  // ── Операции Git ────────────────────────────────────────────────

  private async gitAdd(repoDir: string, files: string[]): Promise<void> {
    await execFileAsync("git", ["add", ...files], { cwd: repoDir });
  }

  private async gitCommit(repoDir: string, message: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["commit", "-m", message, "--allow-empty"],
      { cwd: repoDir },
    );
    // Извлекает commit SHA from output: "[main abc1234] message"
    const match = stdout.match(/\b([0-9a-f]{7,40})\b/);
    if (!match) {
      // Резервный: use git rev-parse HEAD
      const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      return sha.trim();
    }
    return match[1]!;
  }
}
