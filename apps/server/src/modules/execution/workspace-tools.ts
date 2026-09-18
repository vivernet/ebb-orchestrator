/**
 * WorkspaceTools provides general workspace utilities.
 * All operations are confined to the capability-assigned workspace.
 */
import { PathResolver } from '../../platform/security/path-resolver.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type WorkspaceReadResult = { success: boolean; content?: string; error?: string };
export type WorkspaceWriteResult = { success: boolean; error?: string };

/**
 * Предоставляет execution-контракт workspace-tools с проверкой capability перед побочным эффектом.
 */
export class WorkspaceTools {
  constructor(
    private resolver: PathResolver,
    private workspace: string
  ) {}

  /**
   * Read a file from the workspace.
   */
  async readFile(relPath: string): Promise<WorkspaceReadResult> {
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const content = fs.readFileSync(result.path!, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Read failed' };
    }
  }

  /**
   * Write a file to the workspace.
   */
  async writeFile(relPath: string, content: string): Promise<WorkspaceWriteResult> {
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return { success: false, ...(result.error && { error: result.error }) };
    }

    try {
      const dir = path.dirname(result.path!);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(result.path!, content, 'utf8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Write failed' };
    }
  }

  /**
   * List files in a directory within the workspace.
   */
  async listDir(relPath: string): Promise<string[]> {
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return [];
    }

    try {
      return fs.readdirSync(result.path!).filter(f => !f.startsWith('.'));
    } catch {
      return [];
    }
  }

  /**
   * Check if a path exists in the workspace.
   */
  async exists(relPath: string): Promise<boolean> {
    const fullPath = path.join(this.workspace, relPath);
    const result = await this.resolver.resolveSafePath(this.workspace, fullPath);

    if (!result.success) {
      return false;
    }

    return fs.existsSync(result.path!);
  }
}
