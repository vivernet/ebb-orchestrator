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
});
