/**
 * GitTools provides git operations scoped to the capability-assigned worktree.
 * Git operations always resolve from RunCapability's workspace, not from model input.
 */
import * as cp from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(require('node:child_process').exec);

export class GitTools {
  constructor(private workspace: string) {}

  /** Initialize a git repository in the workspace */
  async initRepo(): Promise<string> {
    try {
      const { stdout } = await exec('git init', { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return (err as Error).message;
    }
  }

  /**
   * Get git status.
   * Always scoped to capability-assigned worktree.
   */
  async status(): Promise<string> {
    try {
      const { stdout } = await exec('git status --porcelain', { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return '';
    }
  }

  /**
   * Get git diff for unstaged changes.
   * Always scoped to capability-assigned worktree.
   */
  async diff(): Promise<string> {
    try {
      const { stdout } = await exec('git diff', { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return '';
    }
  }

  /**
   * Get git diff for staged changes.
   * Always scoped to capability-assigned worktree.
   */
  async diffStaged(): Promise<string> {
    try {
      const { stdout } = await exec('git diff --cached', { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return '';
    }
  }

  /**
   * Stage files for commit.
   * Always scoped to capability-assigned worktree.
   */
  async add(patterns: string[]): Promise<string> {
    try {
      const args = patterns.map(p => `"${p}"`).join(' ');
      const { stdout } = await exec(`git add ${args}`, { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return (err as Error).message;
    }
  }

  /**
   * Commit staged changes.
   * Always scoped to capability-assigned worktree.
   */
  async commit(message: string): Promise<string> {
    try {
      const { stdout } = await exec(`git commit -m "${message}"`, { cwd: this.workspace });
      return stdout;
    } catch (err: unknown) {
      return (err as Error).message;
    }
  }

  /**
   * Get current branch.
   * Always scoped to capability-assigned worktree.
   */
  async branch(): Promise<string> {
    try {
      const { stdout } = await exec('git branch --show-current', { cwd: this.workspace });
      return stdout.trim();
    } catch (err: unknown) {
      return '';
    }
  }
}
