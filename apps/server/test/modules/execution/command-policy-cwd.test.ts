import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { CommandPolicy, CWD_NOT_ALLOWED, type CommandInvocation, type CommandPolicyDefinition } from '../../../src/modules/execution/command-policy.js';

describe('CommandPolicy cwd invariant', () => {
  let testDir: string;
  let workspaceDir: string;
  let policy: CommandPolicy;
  let definition: CommandPolicyDefinition;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `command-policy-cwd-test-${crypto.randomBytes(4).toString('hex')}`);
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

  it('rejects an invocation that carries a cwd field', () => {
    const invocation = { policyId: 'package-check', args: ['--version'], cwd: tmpdir() } as unknown as CommandInvocation;
    expect(policy.resolve(invocation)).toEqual({ valid: false, error: CWD_NOT_ALLOWED });
  });

  it('rejects cwd even when its value is undefined', () => {
    const invocation = { policyId: 'package-check', args: ['--version'], cwd: undefined } as unknown as CommandInvocation;
    expect(policy.resolve(invocation)).toEqual({ valid: false, error: CWD_NOT_ALLOWED });
  });

  it('still resolves the same invocation without cwd', () => {
    expect(policy.resolve({ policyId: 'package-check', args: ['--version'] })).toMatchObject({
      valid: true,
      command: { cwd: realpathSync(workspaceDir) },
    });
  });
});
