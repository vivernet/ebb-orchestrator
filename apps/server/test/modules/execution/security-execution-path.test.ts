import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PathResolver } from '../../../src/platform/security/path-resolver.js';
import { CommandTools } from '../../../src/modules/execution/command-tools.js';

describe('security execution and path remediation', () => {
  it('rejects new targets beneath an escaping Unix symlink', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(tmpdir(), 'security-path-'));
    try {
      const workspace = path.join(root, 'workspace');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(workspace); fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(workspace, 'link'), 'dir');
      expect((await new PathResolver().resolveSafePath(workspace, 'link/new.txt')).success).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects new targets beneath a dangling Unix symlink', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(tmpdir(), 'security-path-'));
    try {
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(workspace);
      fs.symlinkSync(path.join(root, 'missing'), path.join(workspace, 'link'), 'dir');
      expect((await new PathResolver().resolveSafePath(workspace, 'link/new.txt')).success).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('allows new files beneath the real workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'security-path-'));
    try { expect((await new PathResolver().resolveSafePath(workspace, 'new/dir/file.txt')).success).toBe(true); }
    finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('returns timeout and output-bound failures without changing result shape', async () => {
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'security-command-'));
    try {
      const tools = new CommandTools();
      const timeout = await tools.exec({ executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], timeout: 20 }, workspace);
      const output = await tools.exec({ executable: 'node', args: ['-e', 'process.stdout.write("x".repeat(10000))'], maxOutput: 100 }, workspace);
      expect(timeout.success).toBe(false); expect(timeout.stderr).toContain('timed out');
      expect(output.success).toBe(false); expect(output.stderr).toContain('buffer exceeded');
      expect(Object.keys(timeout).sort()).toEqual(['exitCode', 'stderr', 'stdout', 'success']);
    } finally { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it('passes AbortSignal through CommandTools to ProcessExecutor', async () => {
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'security-command-'));
    try {
      const controller = new AbortController();
      const pending = new CommandTools().exec({
        executable: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], signal: controller.signal,
      }, workspace);
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('timed out');
    } finally { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });
});
