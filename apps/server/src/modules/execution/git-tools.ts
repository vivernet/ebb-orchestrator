/**
 * GitTools provides git operations scoped to Объект capability-assigned worktree.
 * Операции Git always resolve from RunCapability's workspace, not from model input.
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
    if (patterns.length === 0 || patterns.some((pattern) => !isSafeWorkspacePath(pattern))) {
      throw new Error('Invalid Git add paths');
    }
    return (await this.git.run(this.workspace, ['add', '--', ...patterns.map((pattern) => `:(literal)${pattern}`)])).stdout;
  }

  async commit(message: string): Promise<string> {
    // Managed commits must not run repository hooks; preserve process failure so MCP never reports a false success.
    return (await this.git.run(this.workspace, ['commit', '--no-verify', '-m', message])).stdout;
  }

  async branch(): Promise<string> {
    try { return (await this.git.run(this.workspace, ['branch', '--show-current'])).stdout.trim(); } catch { return ''; }
  }

  /** Возвращает только полный hex SHA текущего HEAD после фиксированной команды `git rev-parse HEAD`. */
  async headSha(): Promise<string> {
    try {
      const value = (await this.git.run(this.workspace, ['rev-parse', 'HEAD'])).stdout.trim();
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value) ? value : '';
    } catch {
      return '';
    }
  }
}

function isSafeWorkspacePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes(':') || value.startsWith('/') || value.startsWith('\\') ||
      /^[A-Za-z]:/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
    return false;
  }
  const segments = value.replace(/\\/g, '/').split('/');
  return value !== '.' && segments.every((segment) => segment !== '..');
}
