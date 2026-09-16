/**
 * ActionGateway enforces path confinement for workspace operations.
 * All file operations must be scoped to the capability-assigned workspace.
 */
import { PathResolver } from '../../platform/security/path-resolver';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type FilePatch = { start: number; end: number; content: string };
export type FilePatchResult = { success: boolean; error?: string };

export class ActionGateway {
  constructor(
    private resolver: PathResolver,
    private workspace: string
  ) {}

  /**
   * Read a file from the workspace.
   */
  async readFile(relPath: string): Promise<{ success: boolean; content?: string; error?: string }> {
    // Use path.join for proper path construction
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    try {
      const content = fs.readFileSync(path.join(this.workspace, relPath), 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
    }
  }

  /**
   * Search for patterns in the workspace.
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
      } catch {}
    };

    searchDir(this.workspace);
    return results;
  }

  /**
   * Patch a file in the workspace.
   */
  async patch(relPath: string, patches: FilePatch[]): Promise<FilePatchResult> {
    // Use path.join for proper path construction
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, error: result.error };
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
