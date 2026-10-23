/**
 * WorkspaceTools предоставляет общие утилиты workspace.
 * Все операции ограничены workspace, назначенным capability.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { approvedConfigFileForPath } from './approved-config-file.js';
import { resolveArgsWithScope } from '../../platform/security/path-scope.js';

export type WorkspaceReadResult = { success: boolean; content?: string; error?: string };
export type WorkspaceWriteResult = { success: boolean; error?: string };

/**
 * Предоставляет execution-контракт workspace-tools с проверкой capability перед побочным эффектом.
 */
export class WorkspaceTools {
  constructor(
    private resolver: PathResolver,
    private workspace: string,
    private readonly approvedConfigFiles?: Readonly<Record<string, string>>,
  ) {}

  /**
   * Проводит входной путь через `resolveArgsWithScope`: отклоняет foreign
   * absolute и вне-workspace пути, возвращает канонический путь внутри workspace.
   */
  private resolveInScope(relPath: string): { ok: true; path: string } | { ok: false; error: string } {
    const result = resolveArgsWithScope(this.workspace, { path: relPath }, ['path'] as const, this.resolver);
    if (!result.ok) return result;
    return { ok: true, path: result.args.path as string };
  }

  /**
   * Читает файл из workspace.
   */
  async readFile(relPath: string): Promise<WorkspaceReadResult> {
    const approved = approvedConfigFileForPath(this.workspace, relPath, this.approvedConfigFiles);
    if (approved.applies) return approved.content === undefined
      ? { success: false, error: 'File is absent from approved Project Config snapshot' }
      : { success: true, content: approved.content };
    const resolved = this.resolveInScope(relPath);

    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    try {
      const content = fs.readFileSync(resolved.path, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
    }
  }

  /**
   * Записывает файл в workspace.
   */
  async writeFile(relPath: string, content: string): Promise<WorkspaceWriteResult> {
    const resolved = this.resolveInScope(relPath);

    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    try {
      const dir = path.dirname(resolved.path);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved.path, content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Write failed' };
    }
  }

  /**
   * Возвращает список файлов в каталоге внутри workspace.
   */
  async listDir(relPath: string): Promise<string[]> {
    const resolved = this.resolveInScope(relPath);

    if (!resolved.ok) {
      return [];
    }

    try {
      return fs.readdirSync(resolved.path).filter(f => !f.startsWith('.'));
    } catch {
      return [];
    }
  }

  /**
   * Проверяет существование пути в workspace.
   */
  async exists(relPath: string): Promise<boolean> {
    const resolved = this.resolveInScope(relPath);

    if (!resolved.ok) {
      return false;
    }

    return fs.existsSync(resolved.path);
  }
}
