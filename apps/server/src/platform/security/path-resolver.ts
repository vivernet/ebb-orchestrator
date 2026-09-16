/**
 * PathResolver provides secure path containment checking.
 * It ensures that file operations stay within a designated workspace.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';

export class PathResolver {
  /**
   * Resolves a target path and checks if it's contained within the workspace.
   * Uses fs.realpathSync() to resolve symlinks/junctions before containment check.
   * @param workspace The absolute workspace path (root)
   * @param target The target path to resolve (absolute or relative)
   * @returns Promise<{ success: boolean; path?: string; error?: string }>
   */
  async resolveSafePath(workspace: string, target: string): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      // Check for absolute path outside workspace immediately
      if (path.isAbsolute(target)) {
        // Normalize workspace and target for comparison
        const normalizedWorkspace = path.resolve(workspace);
        const normalizedTarget = path.resolve(target);
        
        // If target is absolute and doesn't start with workspace, reject
        if (!this.isWithinWorkspace(normalizedWorkspace, normalizedTarget)) {
          return { success: false, error: 'Path is outside workspace' };
        }
      }

      // Resolve workspace to absolute path without symlinks for base comparison
      const normalizedWorkspace = path.resolve(workspace);
      
      // For target, compute the resolved path first
      const resolvedTarget = path.resolve(normalizedWorkspace, target);

      // Use realpath to resolve symlinks and junctions
      let realWorkspace: string;
      let realTarget: string;
      
      try {
        realWorkspace = fs.realpathSync(normalizedWorkspace);
        realTarget = fs.realpathSync(resolvedTarget);
      } catch {
        // If realpath fails, fall back to resolved paths
        realWorkspace = normalizedWorkspace;
        realTarget = resolvedTarget;
      }

      // Check containment: realTarget must be within realWorkspace
      if (!this.isWithinWorkspace(realWorkspace, realTarget)) {
        return { success: false, error: 'Path is outside workspace' };
      }

      // Convert to platform-native path and normalize to relative from root
      // Output path should not start with /
      const relativePath = path.relative(path.parse(realTarget).root, realTarget);
      const normalizedPath = relativePath.split(path.sep).join('/');
      
      return { success: true, path: normalizedPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Path resolution failed' };
    }
  }

  /**
   * Checks if a target path is contained within workspace without full resolution.
   */
  isPathContained(workspace: string, target: string): boolean {
    try {
      const normalizedWorkspace = path.resolve(workspace);
      const normalizedTarget = path.resolve(normalizedWorkspace, target);

      // Use realpath to resolve symlinks and junctions
      let realWorkspace: string;
      let realTarget: string;
      
      try {
        realWorkspace = fs.realpathSync(normalizedWorkspace);
        realTarget = fs.realpathSync(normalizedTarget);
      } catch {
        realWorkspace = normalizedWorkspace;
        realTarget = normalizedTarget;
      }

      return this.isWithinWorkspace(realWorkspace, realTarget);
    } catch {
      return false;
    }
  }

  /**
   * Check if target is within workspace after realpath resolution.
   * Handles both Unix symlinks and Windows junctions.
   */
  private isWithinWorkspace(workspace: string, target: string): boolean {
    // Ensure workspace ends with separator for proper prefix matching
    const workspaceNormalized = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
    const targetNormalized = target.endsWith(path.sep) ? target : target + path.sep;
    
    // Target must start with workspace path
    if (!targetNormalized.startsWith(workspaceNormalized)) {
      return false;
    }

    // For absolute paths, ensure they start with the same drive letter (Windows)
    if (path.isAbsolute(workspace) && path.isAbsolute(target)) {
      const workspaceDrive = path.parse(workspace).root;
      const targetDrive = path.parse(target).root;
      if (workspaceDrive !== targetDrive) {
        return false;
      }
    }

    return true;
  }
}
