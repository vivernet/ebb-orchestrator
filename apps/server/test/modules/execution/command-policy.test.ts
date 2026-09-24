import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { CommandPolicy } from '../../../src/modules/execution/command-policy.js';

describe('CommandPolicy', () => {
  let testDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `command-policy-test-${crypto.randomBytes(4).toString('hex')}`);
    workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Игнорируем ошибки очистки.
    }
  });

  describe('executable allowlist', () => {
    it('should allow executables in the allowlist', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node', 'npm', 'npx'] });
      expect(policy.isExecutableAllowed('node')).toBe(true);
      expect(policy.isExecutableAllowed('npm')).toBe(true);
      expect(policy.isExecutableAllowed('npx')).toBe(true);
    });

    it('should deny executables not in the allowlist', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node', 'npm'] });
      expect(policy.isExecutableAllowed('npx')).toBe(false);
      expect(policy.isExecutableAllowed('sh')).toBe(false);
      expect(policy.isExecutableAllowed('bash')).toBe(false);
    });

    it('should deny shell executables by default', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      expect(policy.isExecutableAllowed('sh')).toBe(false);
      expect(policy.isExecutableAllowed('bash')).toBe(false);
      expect(policy.isExecutableAllowed('zsh')).toBe(false);
      expect(policy.isExecutableAllowed('cmd')).toBe(false);
      expect(policy.isExecutableAllowed('powershell')).toBe(false);
    });
  });

  describe('typed arguments validation', () => {
    it('should validate args are strings', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const isValid = policy.validateArgs(['--version', '-v']);
      expect(isValid.valid).toBe(true);
    });

    it('should reject non-string arguments', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const isValid = policy.validateArgs(['--version', 123]);
      expect(isValid.valid).toBe(false);
      expect(isValid.error).toContain('argument');
    });

    it('should reject empty args array', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const isValid = policy.validateArgs([]);
      expect(isValid.valid).toBe(true);
    });
  });

  describe('path containment checks', () => {
    it('should validate path is within workspace', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const isValid = policy.validatePath('test.txt', workspaceDir);
      expect(isValid.valid).toBe(true);
    });

    it('should reject path traversal attempts', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const isValid = policy.validatePath('../../../etc/passwd', workspaceDir);
      expect(isValid.valid).toBe(false);
      expect(isValid.error).toContain('workspace');
    });

    it('should reject paths outside workspace', () => {
      const policy = new CommandPolicy({ allowedExecutables: ['node'] });
      const outsidePath = path.join(testDir, 'outside.txt');
      const isValid = policy.validatePath(outsidePath, workspaceDir);
      expect(isValid.valid).toBe(false);
    });
  });

  describe('timeout and output limits', () => {
    it('should validate timeout is within limits', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'], 
        maxTimeout: 300000,
        maxOutput: 10485760 
      });
      const isValid = policy.validateOptions({ timeout: 60000 });
      expect(isValid.valid).toBe(true);
    });

    it('should reject timeout exceeding limit', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'], 
        maxTimeout: 60000 
      });
      const isValid = policy.validateOptions({ timeout: 120000 });
      expect(isValid.valid).toBe(false);
      expect(isValid.error).toContain('Timeout');
    });

    it('should validate output size limit', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'],
        maxOutput: 1048576 
      });
      const isValid = policy.validateOptions({ maxOutput: 524288 });
      expect(isValid.valid).toBe(true);
    });

    it('should reject output size exceeding limit', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'],
        maxOutput: 1048576 
      });
      const isValid = policy.validateOptions({ maxOutput: 2097152 });
      expect(isValid.valid).toBe(false);
      expect(isValid.error).toContain('Output');
    });
  });

  describe('command execution policy', () => {
    it('should validate complete exec options', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node', 'npm'],
        maxTimeout: 300000,
        maxOutput: 10485760 
      });
      const isValid = policy.validateExecOptions({
        executable: 'node',
        args: ['--version'],
        timeout: 60000,
        maxOutput: 1048576
      });
      expect(isValid.valid).toBe(true);
    });

    it('should reject invalid executable in exec options', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'],
        maxTimeout: 300000,
        maxOutput: 10485760 
      });
      const isValid = policy.validateExecOptions({
        executable: 'bash',
        args: ['-c', 'echo test']
      });
      expect(isValid.valid).toBe(false);
      expect(isValid.error).toContain('Executable');
    });

    it('should reject shell executables', () => {
      const policy = new CommandPolicy({ 
        allowedExecutables: ['node'],
        maxTimeout: 300000,
        maxOutput: 10485760 
      });
      const isValid = policy.validateExecOptions({
        executable: 'sh',
        args: ['-c', 'echo test']
      });
      expect(isValid.valid).toBe(false);
    });
  });
});
