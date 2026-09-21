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
    gateway = new ActionGateway(resolver, workspaceDir, ['workspace.read', 'workspace.search', 'workspace.patch', 'project.test']);
  });

   afterEach(() => {
     try {
       fs.rmSync(testDir, { recursive: true, force: true });
     } catch {
  // Игнорируем ошибки очистки.
     }
   });

  describe('workspace.read', () => {
    it('should read files within workspace', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'content');
      
      const result = await gateway.readFile('test.txt');
      expect(result.success).toBe(true);
      expect(result.content).toBe('content');
    });

    it('denies reads when the run capability excludes workspace.read', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'test.txt'), 'content');
      const readOnlyByName = new ActionGateway(resolver, workspaceDir, []);

      await expect(readOnlyByName.readFile('test.txt')).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('workspace.read'),
      });
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
  // Проверяем существование файла.
      expect(fs.existsSync(file)).toBe(true);
      const results = await gateway.search('searchable', '*.txt');
      expect(results.length).toBeGreaterThan(0);
    });

    it('treats the supplied pattern as literal text and caps the result count', async () => {
      for (let index = 0; index < 110; index += 1) {
        fs.writeFileSync(path.join(workspaceDir, `result-${index}.txt`), 'literal [needle]');
      }

      await expect(gateway.search('[needle]', '*.txt')).resolves.toHaveLength(100);
    });

    it('denies searches when the run capability excludes workspace.search', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'test.txt'), 'content');
      const withoutSearch = new ActionGateway(resolver, workspaceDir, ['workspace.read']);

      await expect(withoutSearch.search('content', '*.txt')).resolves.toEqual([]);
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
        { start: 0, end: 7, content: 'modified' }
      ]);
      expect(result.success).toBe(true);
    });

    it('rejects invalid patch ranges without changing the file', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'initial');

      const result = await gateway.patch('test.txt', [
        { start: -1, end: 1, content: 'modified' },
      ]);

      expect(result.success).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('initial');
    });

    it('rejects a file replaced between verification and descriptor acquisition', async () => {
      const file = path.join(workspaceDir, 'test.txt');
      const replacement = path.join(testDir, 'replacement.txt');
      fs.writeFileSync(file, 'initial');
      fs.writeFileSync(replacement, 'replacement');

      let replaced = false;
      const swappingGateway = new ActionGateway(
        resolver,
        workspaceDir,
        ['workspace.read', 'workspace.search', 'workspace.patch', 'project.test'],
        undefined,
        (filePath, flags) => {
          if (!replaced && filePath === file) {
            fs.renameSync(replacement, file);
            replaced = true;
          }
          return fs.openSync(filePath, flags);
        },
      );

      const result = await swappingGateway.patch('test.txt', [
        { start: 0, end: 7, content: 'modified' },
      ]);

      expect(result.success).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
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
  // Создаём symlink, указывающий за пределы workspace.
      const link = path.join(workspaceDir, 'escape');
      const outside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(outside, 'external');
       try {
         fs.symlinkSync(outside, link);
       } catch {
    // Symlink может не поддерживаться на всех платформах.
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
