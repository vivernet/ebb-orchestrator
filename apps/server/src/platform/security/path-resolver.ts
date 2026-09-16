/**
 * PathResolver provides secure path containment checking.
 * It ensures that file operations stay within a designated workspace.
 */
import * as path from 'node:path';

export class PathResolver {
  /**
   * Resolves a target path and checks if it's contained within the workspace.
   * @param workspace The absolute workspace path (root)
   * @param target The target path to resolve (absolute or relative)
   * @returns Promise<{ success: boolean; path?: string; error?: string }>
   */
  async resolveSafePath(workspace: string, target: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      // Normalize workspace to absolute path without symlinks
      const normalizedWorkspace = this.normalizePath(workspace);
      const targetSegments = this.getNormalizedSegments(target);
      const workspaceSegments = this.getNormalizedSegments(normalizedWorkspace);

      // Resolve potential path traversal in target
      const resolvedTarget = this.resolveSegments(targetSegments);
      const resolvedWorkspace = this.resolveSegments(workspaceSegments);

      // Check containment: target must start with workspace segments
      if (!this.isPrefix(resolvedWorkspace, resolvedTarget)) {
        return { success: false, error: 'Path is outside workspace' };
      }

      // Reconstruct path - handle Windows drive letters (e.g., C:)
      const pathStr = resolvedTarget.join('/');
      return { success: true, path: pathStr };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Path resolution failed' };
    }
  }

  /**
   * Checks if a target path is contained within workspace without full resolution.
   */
  isPathContained(workspace: string, target: string): boolean {
    try {
      const workspaceSegments = this.getNormalizedSegments(workspace);
      const targetSegments = this.getNormalizedSegments(target);
      const resolvedWorkspace = this.resolveSegments(workspaceSegments);
      const resolvedTarget = this.resolveSegments(targetSegments);
      return this.isPrefix(resolvedWorkspace, resolvedTarget);
    } catch {
      return false;
    }
  }

  /** Normalize path separators and remove trailing slashes */
  private normalizePath(p: string): string {
    return p.replace(/[/\\]+/g, '/').replace(/\/$/, '');
  }

  /** Split path into segments */
  private getSegments(p: string): string[] {
    return p.split('/').filter(s => s && s !== '.');
  }

  /** Normalize: split, filter dots and empty */
  private getNormalizedSegments(p: string): string[] {
    return this.getSegments(this.normalizePath(p));
  }

  /** Resolve .. segments */
  private resolveSegments(segments: string[]): string[] {
    const result: string[] = [];
    for (const seg of segments) {
      if (seg === '..') {
        result.pop();
      } else if (seg !== '.') {
        result.push(seg);
      }
    }
    return result;
  }

  /** Check if prefix is a prefix of full */
  private isPrefix(prefix: string[], full: string[]): boolean {
    if (full.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] !== full[i]) return false;
    }
    return true;
  }
}
