import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PathResolver } from '../../../src/platform/security/path-resolver.js';

describe('PathResolver', () => {
  const resolver = new PathResolver();

  describe('isPathContained', () => {
    it('should allow files within workspace', () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/src/file.ts';
      expect(resolver.isPathContained(workspace, target)).toBe(true);
    });

    it('should deny files outside workspace', () => {
      const workspace = '/workspace/project';
      const target = '/workspace/other/file.ts';
      expect(resolver.isPathContained(workspace, target)).toBe(false);
    });

    it('should deny path traversal attempts', () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/../../../etc/passwd';
      expect(resolver.isPathContained(workspace, target)).toBe(false);
    });
  });

  describe('resolveSafePath', () => {
    it('returns a canonical absolute path for an existing workspace', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'path-resolver-'));
      try {
        const result = await resolver.resolveSafePath(workspace, 'nested/file.txt');
        expect(result).toEqual({ success: true, path: resolve(workspace, 'nested/file.txt') });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('should resolve valid paths within workspace', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/src/file.ts';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(true);
      expect(result.path).toBe(resolve(workspace, target));
    });

    it('should reject path traversal', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/../../../etc/passwd';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside workspace');
    });

    it('should reject symlink escape', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/../../../etc/passwd';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(false);
    });

    it('should compare segments not prefix strings', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project-evil/file.ts';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(false);
    });
  });

  describe('Windows junction handling', () => {
    it('should handle junction escape attempts', async () => {
      const workspace = 'C:\\workspace\\project';
      const target = 'C:\\workspace\\project\\..\\..\\..\\etc\\passwd';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(false);
    });
  });

  describe('Unix symlink handling', () => {
    it('should handle symlink escape attempts', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/link/to/../../../etc/passwd';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(false);
    });
  });
});
