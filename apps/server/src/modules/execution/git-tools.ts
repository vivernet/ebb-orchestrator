/**
 * GitTools provides git operations scoped to the capability-assigned worktree.
 * Git operations always resolve from RunCapability's workspace, not from model input.
 */
import { GitCli } from '../../modules/git/git-cli.js';

/**
 * Предоставляет execution-контракт git-tools с проверкой capability перед побочным эффектом.
 */
export class GitTools {
  private readonly git: GitCli;

  constructor(private workspace: string) {
    this.git = new GitCli();
  }

  async initRepo(): Promise<string> {
    try {
      // Проект использует `master` как каноническую ветку. Явно задаём её,
      // чтобы результат не зависел от версии/глобальной конфигурации Git и
      // не порождал шумное предупреждение о смене default branch.
      return (await this.git.run(this.workspace, ['init', '--initial-branch=master'])).stdout;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async status(): Promise<string> {
    try { return (await this.git.run(this.workspace, ['status', '--porcelain'])).stdout; } catch { return ''; }
  }

  async diff(): Promise<string> {
    try { return (await this.git.run(this.workspace, ['diff'])).stdout; } catch { return ''; }
  }

  async diffStaged(): Promise<string> {
    try { return (await this.git.run(this.workspace, ['diff', '--cached'])).stdout; } catch { return ''; }
  }

  async add(patterns: string[]): Promise<string> {
    try { return (await this.git.run(this.workspace, ['add', '--', ...patterns])).stdout; }
    catch (err: unknown) { return err instanceof Error ? err.message : String(err); }
  }

  async commit(message: string): Promise<string> {
    try {
      // Managed commits must never run repository hooks, and the message is one argv item.
      return (await this.git.run(this.workspace, ['commit', '--no-verify', '-m', message])).stdout;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async branch(): Promise<string> {
    try { return (await this.git.run(this.workspace, ['branch', '--show-current'])).stdout.trim(); } catch { return ''; }
  }
}
