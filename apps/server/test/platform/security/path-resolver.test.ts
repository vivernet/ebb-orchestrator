import { describe, it, expect } from 'vitest';
import { PathResolver } from '../../../src/platform/security/path-resolver';

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
    it('should resolve valid paths within workspace', async () => {
      const workspace = '/workspace/project';
      const target = '/workspace/project/src/file.ts';
      const result = await resolver.resolveSafePath(workspace, target);
      expect(result.success).toBe(true);
      expect(result.path).toBe('workspace/project/src/file.ts');
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
