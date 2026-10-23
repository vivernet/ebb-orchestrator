import { realpathSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { ActionGateway } from '../../../src/modules/execution/action-gateway.js';
import { CWD_NOT_ALLOWED, type CommandInvocation } from '../../../src/modules/execution/command-policy.js';
import { PATH_OUTSIDE_SCOPE } from '../../../src/platform/security/path-scope.js';
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
      const file = path.join(realpathSync(workspaceDir), 'test.txt');
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
      expect(result.error).toBe(PATH_OUTSIDE_SCOPE);
    });

    it.skipIf(process.platform === 'win32')('fail-closes on a foreign absolute path such as C:\\outside.txt', async () => {
      const literalName = 'C:\\outside.txt';
      fs.writeFileSync(path.join(workspaceDir, literalName), 'external content');
      const result = await gateway.readFile(literalName);
      expect(result.success).toBe(false);
    });
  });

  it('rejects a command invocation when no command policy is declared', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec']);

    await expect(commandGateway.exec({ policyId: 'node-version', args: ['--version'] }))
      .resolves.toMatchObject({ success: false, stderr: 'command.exec has no declared policies' });
  });

  it.each([
    ['direct dash shell', 'dash', ['-c', 'echo unsafe']],
    ['direct fish shell', 'fish', ['-c', 'echo unsafe']],
    ['env shell launcher', 'env', ['bash', '-c', 'echo unsafe']],
    ['busybox shell launcher', 'busybox', ['sh', '-c', 'echo unsafe']],
  ])('rejects %s at action execution', async (_label, executable, args) => {
    const shellGateway = new ActionGateway(resolver, workspaceDir, ['project.test'], {
      commands: { test: { executable, args } },
    });

    await expect(shellGateway.test()).resolves.toMatchObject({
      action: 'test', success: false, stderr: expect.stringMatching(/known shell interpreters or launchers are not allowed/i), exitCode: null,
    });
  });

  it('runs only the exact invocation declared by a command policy', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec'], {
      commands: {},
      commandPolicies: [{
        id: 'node-version', executable: process.execPath,
        args: [{ type: 'string', enum: ['--version'] }],
        allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
      }],
    });

    await expect(commandGateway.exec({ policyId: 'node-version', args: ['--version'] }))
      .resolves.toMatchObject({ success: true, stdout: expect.stringMatching(/^v\d/) });
    await expect(commandGateway.exec({ policyId: 'node-version', args: ['--eval'] }))
      .resolves.toMatchObject({ success: false, stderr: expect.stringContaining('enum') });
  });

  it('enforces command.exec capability before applying a declared policy', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, [], {
      commands: {},
      commandPolicies: [{
        id: 'node-version', executable: process.execPath,
        args: [{ type: 'string', enum: ['--version'] }],
        allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
      }],
    });

    await expect(commandGateway.exec({ policyId: 'node-version', args: ['--version'] }))
      .resolves.toMatchObject({ success: false, stderr: expect.stringContaining('Default deny') });
  });

  it('rejects a command invocation that carries cwd', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec'], {
      commands: {},
      commandPolicies: [{
        id: 'node-version', executable: process.execPath,
        args: [{ type: 'string', enum: ['--version'] }],
        allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
      }],
    });
    const invocation = { policyId: 'node-version', args: ['--version'], cwd: testDir } as unknown as CommandInvocation;

    await expect(commandGateway.exec(invocation))
      .resolves.toMatchObject({ success: false, stderr: CWD_NOT_ALLOWED });
  });

  it('rejects cwd even when no command policy is declared', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec']);
    const invocation = { policyId: 'node-version', args: ['--version'], cwd: testDir } as unknown as CommandInvocation;

    await expect(commandGateway.exec(invocation))
      .resolves.toMatchObject({ success: false, stderr: CWD_NOT_ALLOWED });
  });

  it('rejects a null invocation without throwing', async () => {
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec'], {
      commands: {},
      commandPolicies: [{
        id: 'node-version', executable: process.execPath,
        args: [{ type: 'string', enum: ['--version'] }],
        allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
      }],
    });

    await expect(commandGateway.exec(null as unknown as CommandInvocation))
      .resolves.toMatchObject({ success: false });
  });

  it('enforces policy timeout and output caps on the spawned process', async () => {
    const timeoutScript = path.join(workspaceDir, 'timeout.js');
    const outputScript = path.join(workspaceDir, 'output.js');
    fs.writeFileSync(timeoutScript, 'setTimeout(() => {}, 1000);');
    fs.writeFileSync(outputScript, 'process.stdout.write("x".repeat(10000));');
    const commandGateway = new ActionGateway(resolver, workspaceDir, ['command.exec'], {
      commands: {},
      commandPolicies: [
        { id: 'timeout', executable: process.execPath, args: [{ type: 'workspace-path' }], allowedRoots: [workspaceDir], timeout: 20, maxOutput: 1_024 },
        { id: 'output', executable: process.execPath, args: [{ type: 'workspace-path' }], allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 64 },
      ],
    });

    await expect(commandGateway.exec({ policyId: 'timeout', args: ['timeout.js'] }))
      .resolves.toMatchObject({ success: false, stderr: expect.stringContaining('timed out') });
    await expect(commandGateway.exec({ policyId: 'output', args: ['output.js'] }))
      .resolves.toMatchObject({ success: false, stderr: expect.stringContaining('output buffer exceeded') });
  });

  describe('command.exec security blacklist (A3)', () => {
    const blacklistGateway = () => new ActionGateway(resolver, workspaceDir, ['command.exec'], {
      commands: {},
      commandPolicies: [{
        id: 'rm-rf', executable: path.join(workspaceDir, 'rm'),
        args: [{ type: 'string', enum: ['-rf'] }, { type: 'workspace-path' }],
        allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
      }],
    });

    it('блокирует blacklist-команду до запуска процесса, даже при capability ALLOW', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'target.txt'), 'x');

      const result = await blacklistGateway().exec({ policyId: 'rm-rf', args: ['-rf', 'target.txt'] });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('cmd-rm-rf');
      expect(result.stderr).not.toContain('spawn');
      expect(result.stdout).toBe('');
    });

    it('near-miss команда не блокируется и доходит до process executor', async () => {
      const gateway = new ActionGateway(resolver, workspaceDir, ['command.exec'], {
        commands: {},
        commandPolicies: [{
          id: 'rm-single', executable: path.join(workspaceDir, 'rm'),
          args: [{ type: 'string', enum: ['-f'] }],
          allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
        }],
      });

      const result = await gateway.exec({ policyId: 'rm-single', args: ['-f'] });

      expect(result.success).toBe(false);
      expect(result.stderr).not.toContain('security blacklist');
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

    it('does not follow a symlinked directory pointing outside the workspace', async () => {
      const outside = path.join(testDir, 'outside-search');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'leak.txt'), 'needle content');
      try {
        fs.symlinkSync(outside, path.join(workspaceDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return; // Symlink может не поддерживаться на всех платформах.
      }

      const results = await gateway.search('needle', '*.txt');
      expect(results).toEqual([]);
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
      const file = path.join(realpathSync(workspaceDir), 'test.txt');
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

  describe('workspace.patch частичное применение (E1)', () => {
    it('применяет все операции полного мульти-патча со статусом applied', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'alpha');
      fs.writeFileSync(path.join(workspaceDir, 'b.txt'), 'beta');

      const result = await gateway.patch([
        { path: 'a.txt', patches: [{ start: 0, end: 5, content: 'ALPHA' }] },
        { path: 'b.txt', patches: [{ start: 0, end: 4, content: 'BETA' }] },
      ]);

      expect(result).toEqual({
        success: true,
        status: 'applied',
        applied: [
          { path: 'a.txt', success: true },
          { path: 'b.txt', success: true },
        ],
        failed: [],
      });
      expect(fs.readFileSync(path.join(workspaceDir, 'a.txt'), 'utf8')).toBe('ALPHA');
      expect(fs.readFileSync(path.join(workspaceDir, 'b.txt'), 'utf8')).toBe('BETA');
    });

    it('пустой мульти-патч успешен и ничего не применяет', async () => {
      const result = await gateway.patch([]);

      expect(result).toEqual({ success: true, status: 'applied', applied: [], failed: [] });
    });

    it('возвращает partiallyApplied при частично неприменимых операциях без утечки содержимого', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'keep.txt'), 'secret-content');

      const result = await gateway.patch([
        { path: 'keep.txt', patches: [{ start: 0, end: 14, content: 'patched' }] },
        { path: 'missing.txt', patches: [{ start: 0, end: 1, content: 'x' }] },
      ]);

      expect(result.success).toBe(false);
      expect(result.status).toBe('partiallyApplied');
      expect(result.applied).toEqual([{ path: 'keep.txt', success: true }]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ path: 'missing.txt', success: false });
      expect(result.failed[0]?.error).toBeDefined();
      expect(fs.readFileSync(path.join(workspaceDir, 'keep.txt'), 'utf8')).toBe('patched');
      // Результат не содержит содержимого файлов.
      expect(JSON.stringify(result)).not.toContain('secret-content');
      expect(JSON.stringify(result)).not.toContain('patched');
    });

    it('отклоняет все неприменимые операции статусом failed без применения', async () => {
      const result = await gateway.patch([
        { path: 'one-missing.txt', patches: [{ start: 0, end: 1, content: 'x' }] },
        { path: 'two-missing.txt', patches: [{ start: 0, end: 1, content: 'y' }] },
      ]);

      expect(result).toEqual({
        success: false,
        status: 'failed',
        applied: [],
        failed: [
          { path: 'one-missing.txt', success: false, error: expect.any(String) },
          { path: 'two-missing.txt', success: false, error: expect.any(String) },
        ],
      });
      expect(fs.existsSync(path.join(workspaceDir, 'one-missing.txt'))).toBe(false);
      expect(fs.existsSync(path.join(workspaceDir, 'two-missing.txt'))).toBe(false);
    });

    it('валидационный отказ пути отклоняет весь батч до применения', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'valid.txt'), 'untouched');

      const result = await gateway.patch([
        { path: 'valid.txt', patches: [{ start: 0, end: 9, content: 'changed' }] },
        { path: '../outside.txt', patches: [{ start: 0, end: 1, content: 'x' }] },
      ]);

      expect(result).toEqual({
        success: false,
        status: 'failed',
        applied: [],
        failed: [],
        error: PATH_OUTSIDE_SCOPE,
      });
      expect(fs.readFileSync(path.join(workspaceDir, 'valid.txt'), 'utf8')).toBe('untouched');
    });
  });
});
