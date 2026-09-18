/**\
 * Gateway для операций с файлами, обеспечивающий ограничение путей.
 * Все операции с файлами должны быть ограничены workspace, назначенным capability.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectActions, type ProjectConfig, type ActionResult } from './project-actions.js';
import { PermissionEngine } from '../permissions/permission-engine.js';
import { ActionId, type EvaluationInput, PermissionDecision } from '../permissions/permission-types.js';

export type FilePatch = { start: number; end: number; content: string };
export type FilePatchResult = { success: boolean; error?: string };

/**
 * Предоставляет execution-контракт action-gateway с проверкой capability перед побочным эффектом.
 */
export class ActionGateway {
  private readonly permissionEngine: PermissionEngine;

  constructor(
    private resolver: PathResolver,
    private workspace: string,
    private capabilities: ActionId[],
    projectConfig?: ProjectConfig
  ) {
    this.permissionEngine = new PermissionEngine();
    this.projectActions = projectConfig ? new ProjectActions(projectConfig) : null;
  }

  private readonly projectActions: ProjectActions | null;

  /**\
   * Проверяет разрешение на выполнение действия через PermissionEngine.
   * @param actionId Идентификатор действия.
   * @returns true если действие разрешено, иначе false.
   */
  private checkPermission(actionId: ActionId): boolean {
    const input: EvaluationInput = {
      capability: this.capabilities,
      action: actionId,
    };
    const result = this.permissionEngine.evaluate(input);
    return result.decision === PermissionDecision.ALLOW;
  }

  async test(): Promise<ActionResult> {
    if (!this.checkPermission(ActionId.ProjectTest)) {
      return { action: 'test', success: false, stdout: '', stderr: 'Permission denied: project.test action not allowed', exitCode: null };
    }
    if (!this.projectActions) {
      return { action: 'test', success: false, stdout: '', stderr: 'project test is not configured', exitCode: null };
    }
    try {
      return await this.projectActions.test(this.workspace);
    } catch (error) {
      return { action: 'test', success: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: null };
    }
  }

  /**
   * Читает файл из workspace.
   * @param relPath Относительный путь к файлу.
   * @returns Результат операции: успех, содержимое или ошибка.
   */
  async readFile(relPath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    // Use path.join for proper path construction
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const content = fs.readFileSync(path.join(this.workspace, relPath), 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
    }
  }

  /**
   * Выполняет поиск по шаблону в workspace.
   * @param pattern Регулярное выражение для поиска.
   * @param ext Фильтр по расширению файла (например, '.txt').
   * @returns Список путей к файлам, содержащим совпадения.
   */
  async search(pattern: string, ext?: string): Promise<string[]> {
    const results: string[] = [];
    const patternRegex = new RegExp(pattern, 'i');

    const searchDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDir(entryPath);
          } else if (entry.isFile()) {
            const matchesExt = !ext || entry.name.endsWith(ext.slice(1)); // *.txt -> txt
            if (!matchesExt) continue;
            const content = fs.readFileSync(entryPath, 'utf8');
            if (patternRegex.test(content)) {
              results.push(entryPath);
            }
          }
        }
        } catch {
          // Ignore errors during directory traversal
        }
    };

    searchDir(this.workspace);
    return results;
  }

  /**\
   * Применяет патчи к файлу в workspace.
   * @param relPath Относительный путь к файлу.
   * @param patches Массив изменений с диапазонами и новым содержимым.
   * @returns Результат операции замены.
   */
  async patch(relPath: string, patches: FilePatch[]): Promise<FilePatchResult> {
    if (!this.checkPermission(ActionId.WorkspacePatch)) {
      return { success: false, error: 'Permission denied: workspace.patch action not allowed' };
    }
    // Use path.join for proper path construction
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      let patched = content;
      let offset = 0;

      for (const patch of patches) {
        const start = patch.start + offset;
        const end = patch.end + offset;
        patched = patched.slice(0, start) + patch.content + patched.slice(end);
        offset += patch.content.length - (patch.end - patch.start);
      }

      fs.writeFileSync(fullPath, patched, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Patch failed' };
    }
  }
}
