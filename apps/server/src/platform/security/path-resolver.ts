/** Безопасно разрешает пути с учётом symlink и junction. */
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Реализует security boundary path-resolver; входные данные должны пройти предусмотренные проверки доверия.
 */
export class PathResolver {
  async resolveSafePath(workspace: string, target: string): Promise<{ success: boolean; path?: string; error?: string }> {
    return this.resolveSafePathSync(workspace, target);
  }

  /**
   * Синхронно канонизирует путь для операции в workspace. Возвращаемый путь
   * всегда абсолютный: вызывающий код не должен повторно собирать его из
   * исходного недоверенного значения.
   */
  resolveSafePathSync(workspace: string, target: string): { success: boolean; path?: string; error?: string } {
    const pathApi = this.pathApiFor(workspace);
    try {
      if (this.isForeignAbsolutePath(workspace, target)) {
        return { success: false, error: 'Path is outside workspace' };
      }
      const root = pathApi.resolve(workspace);
      const requested = pathApi.resolve(root, target);
      const realRoot = fs.realpathSync(root);
      const realTarget = this.resolveExistingAncestor(requested, pathApi);
      if (!this.isWithinWorkspace(realRoot, realTarget, pathApi)) return { success: false, error: 'Path is outside workspace' };
      return { success: true, path: realTarget };
    } catch (err) {
      // Выполняет соответствующую проверку или действие согласно контракту.
      // Выполняет соответствующую проверку или действие согласно контракту.
      try {
        const root = pathApi.resolve(workspace);
        const requested = pathApi.resolve(root, target);
        if (!this.isWithinWorkspace(root, requested, pathApi)) return { success: false, error: 'Path is outside workspace' };
        if (!this.hasExistingRoot(root)) {
          return { success: true, path: requested };
        }
        // Выполняет соответствующую проверку или действие согласно контракту.
        // Выполняет соответствующую проверку или действие согласно контракту.
        // Выполняет соответствующую проверку или действие согласно контракту.
        return { success: false, error: 'Path resolution failed' };
      } catch { /* fail closed below */ }
      return { success: false, error: err instanceof Error ? err.message : 'Path resolution failed' };
    }
  }

  isPathContained(workspace: string, target: string): boolean {
    try {
      if (this.isForeignAbsolutePath(workspace, target)) return false;
      const pathApi = this.pathApiFor(workspace);
      const root = pathApi.resolve(workspace);
      const requested = pathApi.resolve(root, target);
      if (!this.hasExistingRoot(root)) return this.isWithinWorkspace(root, requested, pathApi);
      return this.isWithinWorkspace(fs.realpathSync(root), this.resolveExistingAncestor(requested, pathApi), pathApi);
    } catch { return false; }
  }

  private pathApiFor(workspace: string): typeof path.posix | typeof path.win32 {
    // Выполняет соответствующую проверку или действие согласно контракту.
    // Выполняет соответствующую проверку или действие согласно контракту.
    // Выполняет соответствующую проверку или действие согласно контракту.
    return process.platform === 'win32' || this.isWindowsPath(workspace) ? path.win32 : path.posix;
  }

  private isWindowsPath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  }

  private isForeignAbsolutePath(workspace: string, target: string): boolean {
    return !this.isWindowsPath(workspace) && (/^[A-Za-z]:/.test(target) || target.startsWith('\\\\'));
  }

  private hasExistingRoot(root: string): boolean {
    try {
      // Выполняет соответствующую проверку или действие согласно контракту.
      // Выполняет соответствующую проверку или действие согласно контракту.
      fs.lstatSync(root);
      return true;
    } catch {
      return false;
    }
  }

  private resolveExistingAncestor(target: string, pathApi: typeof path.posix | typeof path.win32): string {
    const suffix: string[] = [];
    let current = target;
    while (true) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (err: unknown) {
        if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'ENOENT') {
          throw new Error('Unable to inspect path', { cause: err });
        }
        const parent = pathApi.dirname(current);
        if (parent === current) throw new Error('No existing ancestor', { cause: err });
        suffix.unshift(pathApi.basename(current));
        current = parent;
        continue;
      }
      // Выполняет соответствующую проверку или действие согласно контракту.
      // Выполняет соответствующую проверку или действие согласно контракту.
      if (stat.isSymbolicLink()) return pathApi.resolve(fs.realpathSync(current), ...suffix);
      if (!stat.isDirectory() && suffix.length > 0) {
        throw new Error('Existing ancestor is not a directory', { cause: stat });
      }
      return pathApi.resolve(fs.realpathSync(current), ...suffix);
    }
  }

  private isWithinWorkspace(workspace: string, target: string, pathApi: typeof path.posix | typeof path.win32): boolean {
    const relative = pathApi.relative(workspace, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
  }
}
