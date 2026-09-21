/**\
 * Gateway для операций с файлами, обеспечивающий ограничение путей.
 * Все операции с файлами должны быть ограничены workspace, назначенным capability.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectActions, type ProjectAction, type ProjectConfig, type ActionResult } from './project-actions.js';
import { CommandTools, type ExecOptions, type ExecResult } from './command-tools.js';
import { PermissionEngine } from '../permissions/permission-engine.js';
import { ActionId, PermissionDecision, type EvaluationInput } from '../permissions/permission-types.js';

export type FilePatch = { start: number; end: number; content: string };
export type FilePatchResult = { success: boolean; error?: string };
type OpenFile = (filePath: string, flags: number) => number;

const MAX_SEARCH_DEPTH = 32;
const MAX_SEARCH_ENTRIES = 5_000;
const MAX_SEARCH_FILE_BYTES = 1_024 * 1_024;
const MAX_SEARCH_TOTAL_BYTES = 8 * 1_024 * 1_024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_PATTERN_LENGTH = 256;

/**
 * Предоставляет execution-контракт action-gateway с проверкой capability перед побочным эффектом.
 */
export class ActionGateway {
  private readonly permissionEngine: PermissionEngine;

  constructor(
    private resolver: PathResolver,
    private workspace: string,
    private capabilities?: string[],
    projectConfig?: ProjectConfig,
    private readonly openFile: OpenFile = fs.openSync,
  ) {
    this.permissionEngine = new PermissionEngine();
    this.projectActions = projectConfig ? new ProjectActions(projectConfig) : null;
  }

  private readonly projectActions: ProjectActions | null;
  private readonly commandTools = new CommandTools();

  /**
   * Проверяет разрешение на выполнение действия через PermissionEngine.
   * @param actionId Идентификатор действия.
   * @returns true если действие разрешено, иначе false.
   */
  private checkPermission(actionId: ActionId): boolean {
    // Использует PermissionEngine for policy evaluation
    const input: EvaluationInput = {
      capability: (this.capabilities || []) as ActionId[],
      action: actionId,
    };
    const result = this.permissionEngine.evaluate(input);
    return result.decision === PermissionDecision.ALLOW;
  }

  async test(): Promise<ActionResult> {
    return this.runProjectAction('test', ActionId.ProjectTest);
  }

  /** Выполняет настроенную проверку lint внутри capability-bound workspace. */
  async lint(): Promise<ActionResult> {
    return this.runProjectAction('lint', ActionId.ProjectLint);
  }

  /** Выполняет настроенную проверку типов внутри capability-bound workspace. */
  async typecheck(): Promise<ActionResult> {
    return this.runProjectAction('typecheck', ActionId.ProjectTypecheck);
  }

  /** Выполняет настроенную сборку внутри capability-bound workspace. */
  async build(): Promise<ActionResult> {
    return this.runProjectAction('build', ActionId.ProjectBuild);
  }

  /**
   * Выполняет одну из типизированных project actions.
   * @param action Тип проектной проверки.
   * @param actionId Capability action, который должен быть разрешён.
   */
  private async runProjectAction(action: ProjectAction, actionId: ActionId): Promise<ActionResult> {
    if (!this.checkPermission(actionId)) {
      return { action, success: false, stdout: '', stderr: `Permission denied: ${actionId} action not allowed`, exitCode: null };
    }
    if (!this.projectActions) {
      return { action, success: false, stdout: '', stderr: `project ${action} is not configured`, exitCode: null };
    }
    try {
      return await this.projectActions[action](this.workspace);
    } catch (error) {
      return { action, success: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: null };
    }
  }

  /**
   * Выполняет явный executable с аргументами без shell-интерпретации.
   * @param options Команда и безопасные параметры запуска.
   * @returns Результат процесса.
   */
  async exec(options: ExecOptions): Promise<ExecResult> {
    if (!this.checkPermission(ActionId.CommandExec)) {
      return { success: false, stdout: '', stderr: 'Permission denied: command.exec action not allowed', exitCode: null };
    }
    if (!options.executable || !Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string')) {
      return { success: false, stdout: '', stderr: 'invalid command.exec arguments', exitCode: null };
    }
    if (this.commandTools.isShellExecutable(options.executable)) {
      return { success: false, stdout: '', stderr: 'command.shell is not available through command.exec', exitCode: null };
    }
    return this.commandTools.exec(options, this.workspace);
  }

  /**
   * Читает файл из workspace.
   * @param relPath Относительный путь к файлу.
   * @returns Результат операции: успех, содержимое или ошибка.
   */
  async readFile(relPath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    if (!this.checkPermission(ActionId.WorkspaceRead)) {
      return { success: false, error: 'Permission denied: workspace.read action not allowed' };
    }
    const fullPath = path.resolve(this.workspace, relPath);
    const result = this.resolver.resolveSafePathSync(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const content = this.readVerifiedFile(result.path!);
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
    }
  }

  /**
   * Выполняет поиск по шаблону в workspace.
   * @param pattern Литеральный текст для case-insensitive поиска.
   * @param ext Фильтр по расширению файла (например, '.txt').
   * @returns Список путей к файлам, содержащим совпадения.
   */
  async search(pattern: string, ext?: string): Promise<string[]> {
    if (!this.checkPermission(ActionId.WorkspaceSearch)) return [];
    if (pattern.length === 0 || pattern.length > MAX_SEARCH_PATTERN_LENGTH) return [];
    const extension = this.normalizeExtension(ext);
    if (extension === null) return [];

    const results: string[] = [];
    const normalizedPattern = pattern.toLocaleLowerCase();
    let entriesVisited = 0;
    let bytesRead = 0;

    const searchDir = (dir: string, depth: number) => {
      if (depth > MAX_SEARCH_DEPTH || entriesVisited >= MAX_SEARCH_ENTRIES || results.length >= MAX_SEARCH_RESULTS) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entriesVisited >= MAX_SEARCH_ENTRIES || results.length >= MAX_SEARCH_RESULTS) return;
          if (entry.name.startsWith('.')) continue;
          entriesVisited += 1;
          if (entry.isSymbolicLink()) continue;
          const result = this.resolver.resolveSafePathSync(this.workspace, path.resolve(dir, entry.name));
          if (!result.success || !result.path) continue;
          const resolvedPath = result.path;
          const stat = fs.lstatSync(resolvedPath);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) {
            searchDir(result.path, depth + 1);
          } else if (stat.isFile()) {
            const matchesExt = extension === undefined || entry.name.toLocaleLowerCase().endsWith(extension);
            if (!matchesExt) continue;
            if (stat.size > MAX_SEARCH_FILE_BYTES || bytesRead + stat.size > MAX_SEARCH_TOTAL_BYTES) continue;
            const content = this.readVerifiedFile(resolvedPath);
            bytesRead += stat.size;
            if (content.toLocaleLowerCase().includes(normalizedPattern)) {
              results.push(resolvedPath);
            }
          }
        }
        } catch {
          // Ignore errors во время directory traversal
        }
    };

    const root = this.resolver.resolveSafePathSync(this.workspace, this.workspace);
    if (root.success && root.path) searchDir(root.path, 0);
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
    const fullPath = path.resolve(this.workspace, relPath);
    const result = this.resolver.resolveSafePathSync(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const descriptor = this.openVerifiedFile(result.path!, fs.constants.O_RDWR);
      try {
        const content = fs.readFileSync(descriptor, 'utf8');
        if (!this.areValidPatches(patches, content.length)) {
          return { success: false, error: 'Invalid patch ranges' };
        }
        let patched = content;
        let offset = 0;

        for (const patch of patches) {
          const start = patch.start + offset;
          const end = patch.end + offset;
          patched = patched.slice(0, start) + patch.content + patched.slice(end);
          offset += patch.content.length - (patch.end - patch.start);
        }

        this.replaceDescriptorContents(descriptor, patched);
        return { success: true };
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Patch failed' };
    }
  }

  /**
   * Открывает существующий обычный файл и сверяет открытый descriptor с
   * проверенным inode. После возврата чтение и запись должны использовать
   * только этот descriptor, а не исходный pathname.
   */
  private openVerifiedFile(candidate: string, flags = fs.constants.O_RDONLY): number {
    const safePath = this.revalidateFilePath(candidate);
    const expected = fs.lstatSync(safePath);
    if (!expected.isFile()) throw new Error('Only regular files are allowed');

    const descriptor = this.openFile(safePath, flags | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new Error('File changed during descriptor acquisition');
      }
      return descriptor;
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  }

  /** Читает файл только через descriptor, проверенный openVerifiedFile. */
  private readVerifiedFile(candidate: string): string {
    const descriptor = this.openVerifiedFile(candidate);
    try {
      return fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /** Перезаписывает descriptor без повторного разрешения файлового пути. */
  private replaceDescriptorContents(descriptor: number, content: string): void {
    const buffer = Buffer.from(content, 'utf8');
    fs.ftruncateSync(descriptor, 0);
    let written = 0;
    while (written < buffer.length) {
      const bytes = fs.writeSync(descriptor, buffer, written, buffer.length - written, written);
      if (bytes === 0) throw new Error('Unable to write file contents');
      written += bytes;
    }
    fs.fsyncSync(descriptor);
  }

  /** Повторно проверяет канонический путь непосредственно перед открытием descriptor. */
  private revalidateFilePath(candidate: string): string {
    const result = this.resolver.resolveSafePathSync(this.workspace, candidate);
    if (!result.success || !result.path) throw new Error(result.error ?? 'Path resolution failed');
    const stat = fs.lstatSync(result.path);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    return result.path;
  }

  private normalizeExtension(extension: string | undefined): string | undefined | null {
    if (extension === undefined) return undefined;
    const match = /^(?:\*?)(\.[a-z0-9]{1,16})$/i.exec(extension);
    return match ? match[1]!.toLocaleLowerCase() : null;
  }

  private areValidPatches(patches: FilePatch[], contentLength: number): boolean {
    let previousEnd = 0;
    return patches.every((patch) => {
      if (!Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.end)) return false;
      if (patch.start < previousEnd || patch.start < 0 || patch.end < patch.start || patch.end > contentLength) return false;
      previousEnd = patch.end;
      return true;
    });
  }
}
