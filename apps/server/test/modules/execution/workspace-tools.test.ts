import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathResolver } from '../../../src/platform/security/path-resolver.js';
import { WorkspaceTools } from '../../../src/modules/execution/workspace-tools.js';

describe('WorkspaceTools', () => {
  it('uses a canonical absolute path returned by the resolver for real workspaces', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-tools-'));
    try {
      writeFileSync(join(workspace, 'input.txt'), 'input');
      const tools = new WorkspaceTools(new PathResolver(), workspace);

      await expect(tools.readFile('input.txt')).resolves.toMatchObject({ success: true, content: 'input' });
      await expect(tools.writeFile('nested/output.txt', 'output')).resolves.toEqual({ success: true });
      await expect(tools.readFile('nested/output.txt')).resolves.toMatchObject({ success: true, content: 'output' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('fail-closed: refuses a literal Windows absolute path instead of reading it as a relative file inside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workspace-tools-'));
    try {
      // Литеральное имя файла с Windows-синтаксисом существует внутри fixture.
      writeFileSync(join(workspace, 'C:\\outside.txt'), 'forbidden');
      const tools = new WorkspaceTools(new PathResolver(), workspace);

      const result = await tools.readFile('C:\\outside.txt');

      expect(result.success).toBe(false);
      expect(result.content).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
