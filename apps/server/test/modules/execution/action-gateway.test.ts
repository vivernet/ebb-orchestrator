import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { ActionGateway } from '../../../src/modules/execution/action-gateway.js';
import { PathResolver } from '../../../src/platform/security/path-resolver.js';

describe('ActionGateway', () => {
  let testDir: string;
  let workspaceDir: string;
  let resolver: PathResolver;
  let gateway: ActionGateway;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `action-gateway-test-${crypto.randomBytes(4).toString('hex')}`);
    workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    resolver = new PathResolver();
    gateway = new ActionGateway(resolver, workspaceDir);
  });

   afterEach(() => {
     try {
       fs.rmSync(testDir, { recursive: true, force: true });
     } catch {
       // Ignore cleanup errors
     }
   });

  describe('workspace.read', () => {
    it('should read files within workspace', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'content');
      
      const result = await gateway.readFile('test.txt');
      console.log('debug result:', result);
      expect(result.success).toBe(true);
      expect(result.content).toBe('content');
    });

    it('should deny read outside workspace', async () => {
      const fileOutside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(fileOutside, 'external');
      
      const result = await gateway.readFile('../outside.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside workspace');
    });
  });

  describe('workspace.search', () => {
    it('should search within workspace only', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'searchable content');
      // Verify file exists
      expect(fs.existsSync(file)).toBe(true);
      const results = await gateway.search('searchable', '*.txt');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should not search outside workspace', async () => {
      const fileOutside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(fileOutside, 'outside content');
      
      const results = await gateway.search('outside', '*.txt');
      expect(results.length).toBe(0);
    });
  });

  describe('workspace.patch', () => {
    it('should patch files within workspace', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'initial');
      
      const result = await gateway.patch('test.txt', [
        { start: 0, end: 8, content: 'modified' }
      ]);
      expect(result.success).toBe(true);
    });

    it('should deny patch outside workspace', async () => {
      const fileOutside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(fileOutside, 'initial');
      
      const result = await gateway.patch('../outside.txt', [
        { start: 0, end: 8, content: 'modified' }
      ]);
      expect(result.success).toBe(false);
    });
  });

  describe('path traversal protection', () => {
    it('should block path traversal in file paths', async () => {
      const result = await gateway.readFile('../../../etc/passwd');
      expect(result.success).toBe(false);
    });

    it('should handle symlink paths safely', async () => {
      // Create symlink pointing outside workspace
      const link = path.join(workspaceDir, 'escape');
      const outside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(outside, 'external');
       try {
         fs.symlinkSync(outside, link);
       } catch {
         // Symlinks may not be supported on all platforms
       }
      
      const result = await gateway.readFile('escape');
      expect(result.success).toBe(false);
    });
  });

  describe('capability enforcement', () => {
    it('should reject non-existent files', async () => {
      const result = await gateway.readFile('nonexistent.txt');
      expect(result.success).toBe(false);
    });
  });
});
