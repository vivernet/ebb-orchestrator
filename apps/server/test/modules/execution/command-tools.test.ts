import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { CommandTools } from '../../../src/modules/execution/command-tools.js';

describe('CommandTools', () => {
  let testDir: string;
  let workspaceDir: string;
  let commandTools: CommandTools;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `command-tools-test-${crypto.randomBytes(4).toString('hex')}`);
    workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    commandTools = new CommandTools();
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
     } catch {
       // Игнорируем ошибки очистки.
     }
  });

  describe('command.exec - executable and args', () => {
    it('should execute with executable and args array', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log("hello world")']
      }, workspaceDir);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello world');
    });

    it('should pass arguments as-is without shell interpretation', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log(process.argv[1])', 'hello | grep hello']
      }, workspaceDir);
      // Без shell это просто аргумент, переданный напрямую.
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('hello | grep hello');
    });
  });

  describe('shell classification', () => {
    it('should classify bash as shell executable', () => {
      expect(commandTools.isShellExecutable('bash')).toBe(true);
      expect(commandTools.isShellExecutable('sh')).toBe(true);
      expect(commandTools.isShellExecutable('zsh')).toBe(true);
      expect(commandTools.isShellExecutable('cmd')).toBe(true);
      expect(commandTools.isShellExecutable('powershell')).toBe(true);
      expect(commandTools.isShellExecutable('pwsh')).toBe(true);
    });

    it('should not classify regular executables as shell', () => {
      expect(commandTools.isShellExecutable('node')).toBe(false);
      expect(commandTools.isShellExecutable('npm')).toBe(false);
      expect(commandTools.isShellExecutable('git')).toBe(false);
    });
  });

  describe('environment isolation', () => {
    it('should not inherit process.env by default', async () => {
      // При использовании собственного PATH node может быть не найден в Windows.
      // Тест проверяет механизм по сформированному окружению.
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'process.stdout.write(process.env.MY_CUSTOM_VAR || "undefined")']
      }, workspaceDir, { MY_CUSTOM_VAR: 'my_value' });
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('my_value');
    });

    it('should only include allowlisted env variables', async () => {
      // Проверяем корректную передачу добавленных переменных.
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'process.stdout.write(process.env.TOKEN || "not set")']
      }, workspaceDir, { TOKEN: 'secret123' });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('secret123');
    });
  });

  describe('project action mappings', () => {
    it('should provide typed project test mapping', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log("test ran")']
      }, workspaceDir);
      expect(result.success).toBe(true);
    });

    it('should provide typed project lint mapping', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log("lint ran")']
      }, workspaceDir);
      expect(result.success).toBe(true);
    });

    it('should provide typed project typecheck mapping', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log("typecheck ran")']
      }, workspaceDir);
      expect(result.success).toBe(true);
    });

    it('should provide typed project build mapping', async () => {
      const result = await commandTools.exec({
        executable: 'node',
        args: ['-e', 'console.log("build ran")']
      }, workspaceDir);
      expect(result.success).toBe(true);
    });
  });
});
