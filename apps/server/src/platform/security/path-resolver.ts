/** Securely resolve paths while honoring symlinks and junctions. */
import * as path from 'node:path';
import * as fs from 'node:fs';

export class PathResolver {
  async resolveSafePath(workspace: string, target: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const root = path.resolve(workspace);
      const requested = path.resolve(root, target);
      const realRoot = fs.realpathSync(root);
      const realTarget = this.resolveExistingAncestor(requested);
      if (!this.isWithinWorkspace(realRoot, realTarget)) return { success: false, error: 'Path is outside workspace' };
      const relativePath = path.relative(path.parse(realTarget).root, realTarget).split(path.sep).join('/');
      return { success: true, path: relativePath };
    } catch (err) {
      // Preserve purely lexical validation for virtual/nonexistent roots used by callers,
      // but never use it once an existing workspace can expose symlinked ancestors.
      try {
        const root = path.resolve(workspace);
        const requested = path.resolve(root, target);
        if (!this.isWithinWorkspace(root, requested)) return { success: false, error: 'Path is outside workspace' };
        if (!fs.existsSync(root)) {
          return { success: true, path: path.relative(path.parse(requested).root, requested).split(path.sep).join('/') };
        }
      } catch { /* fail closed below */ }
      return { success: false, error: err instanceof Error ? err.message : 'Path resolution failed' };
    }
  }

  isPathContained(workspace: string, target: string): boolean {
    try {
      const root = path.resolve(workspace);
      const requested = path.resolve(root, target);
      if (!fs.existsSync(root)) return this.isWithinWorkspace(root, requested);
      return this.isWithinWorkspace(fs.realpathSync(root), this.resolveExistingAncestor(requested));
    } catch { return false; }
  }

  private resolveExistingAncestor(target: string): string {
    const suffix: string[] = [];
    let current = target;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) throw new Error('No existing ancestor');
      suffix.unshift(path.basename(current));
      current = parent;
    }
    return path.resolve(fs.realpathSync(current), ...suffix);
  }

  private isWithinWorkspace(workspace: string, target: string): boolean {
    const relative = path.relative(workspace, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
}
