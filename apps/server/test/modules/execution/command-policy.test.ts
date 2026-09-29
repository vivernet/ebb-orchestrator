import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { CommandPolicy, type CommandPolicyDefinition } from '../../../src/modules/execution/command-policy.js';

describe('CommandPolicy', () => {
  let testDir: string;
  let workspaceDir: string;
  let policy: CommandPolicy;
  let definition: CommandPolicyDefinition;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `command-policy-test-${crypto.randomBytes(4).toString('hex')}`);
    workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), '{}');
    definition = {
      id: 'package-check',
      executable: process.execPath,
      args: [{ type: 'string', enum: ['--version'] }],
      allowedRoots: [workspaceDir],
      timeout: 5_000,
      maxOutput: 1_024,
    };
    policy = new CommandPolicy(workspaceDir, [definition]);
  });

  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }));

  it('resolves a declared policy to its fixed executable and bounded resources', () => {
    expect(policy.resolve({ policyId: 'package-check', args: ['--version'] })).toMatchObject({
      valid: true,
      command: { executable: process.execPath, args: ['--version'], cwd: workspaceDir, timeout: 5_000, maxOutput: 1_024 },
    });
  });

  it('rejects unknown command ids and arguments with the wrong type or value', () => {
    expect(policy.resolve({ policyId: 'unregistered', args: ['--version'] })).toMatchObject({ valid: false });
    expect(policy.resolve({ policyId: 'package-check', args: [42] })).toMatchObject({ valid: false });
    expect(policy.resolve({ policyId: 'package-check', args: ['--eval'] })).toMatchObject({ valid: false });
  });

  it('rejects shell metacharacters in arguments before execution', () => {
    const shellPolicy = new CommandPolicy(workspaceDir, [{ ...definition, args: [{ type: 'string', pattern: '.*' }] }]);
    expect(shellPolicy.resolve({ policyId: 'package-check', args: ['--version & whoami'] })).toMatchObject({ valid: false });
  });

  it('rejects relative traversal and absolute paths outside allowed roots', () => {
    const pathPolicy = new CommandPolicy(workspaceDir, [{ ...definition, args: [{ type: 'workspace-path' }] }]);
    expect(pathPolicy.resolve({ policyId: 'package-check', args: ['../outside.txt'] })).toMatchObject({ valid: false });
    expect(pathPolicy.resolve({ policyId: 'package-check', args: [path.join(testDir, 'outside.txt')] })).toMatchObject({ valid: false });
  });

  it('rejects a workspace path that escapes through a symlink', () => {
    const outside = path.join(testDir, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(workspaceDir, 'link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const pathPolicy = new CommandPolicy(workspaceDir, [{ ...definition, args: [{ type: 'workspace-path' }] }]);
    expect(pathPolicy.resolve({ policyId: 'package-check', args: ['link'] })).toMatchObject({ valid: false });

    if (process.platform !== 'win32') {
      const danglingLink = path.join(workspaceDir, 'dangling');
      fs.symlinkSync(path.join(outside, 'missing'), danglingLink, 'file');
      expect(pathPolicy.resolve({ policyId: 'package-check', args: ['dangling/child.txt'] })).toMatchObject({ valid: false });
    }
  });

  it('rejects policy definitions with duplicate ids, shell executables, outside roots or unbounded limits', () => {
    expect(() => new CommandPolicy(workspaceDir, [definition, definition])).toThrow(/Invalid command policy/);
    expect(() => new CommandPolicy(workspaceDir, [{ ...definition, executable: 'powershell.exe' }])).toThrow(/Invalid command policy/);
    expect(() => new CommandPolicy(workspaceDir, [{ ...definition, allowedRoots: [testDir] }])).toThrow(/Invalid command policy/);
    expect(() => new CommandPolicy(workspaceDir, [{ ...definition, allowedRoots: [path.join(workspaceDir, 'package.json')] }])).toThrow(/Invalid command policy/);
    expect(() => new CommandPolicy(workspaceDir, [{ ...definition, timeout: 999_999 }])).toThrow(/Invalid command policy/);
    expect(() => new CommandPolicy(workspaceDir, [{ ...definition, maxOutput: 20_000_000 }])).toThrow(/Invalid command policy/);
  });
});
