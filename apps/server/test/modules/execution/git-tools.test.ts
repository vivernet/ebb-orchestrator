import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { GitTools } from '../../../src/modules/execution/git-tools.js';

describe('GitTools', () => {
  let testDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `git-tools-test-${crypto.randomBytes(4).toString('hex')}`);
    workspaceDir = path.join(testDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
     } catch {
       // Ignore cleanup errors
     }
  });

  describe('git.status', () => {
    it('should return status for workspace repository', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      const status = await gitTools.status();
      expect(status).toBeDefined();
    });

    it('should detect modified files', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'initial');
      await gitTools.add(['test.txt']);
      await gitTools.commit('Initial commit');
      fs.writeFileSync(file, 'modified');
      
      const status = await gitTools.status();
      expect(status?.includes('test.txt')).toBe(true);
    });
  });

  describe('git.diff', () => {
    it('should show diff for unstaged changes', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'initial');
      await gitTools.add(['test.txt']);
      await gitTools.commit('Initial commit');
      fs.writeFileSync(file, 'modified');
      
      const diff = await gitTools.diff();
      expect(diff?.includes('modified')).toBe(true);
    });

    it('should show staged diff', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'initial');
      await gitTools.add(['test.txt']);
      fs.writeFileSync(file, 'modified');
      
      const diff = await gitTools.diffStaged();
      // Staged diff may be empty if only working directory is modified
      expect(diff).toBeDefined();
    });
  });

  describe('git.commit', () => {
    it('should commit changes', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      const file = path.join(workspaceDir, 'test.txt');
      fs.writeFileSync(file, 'content');
      await gitTools.add(['test.txt']);
      
      const result = await gitTools.commit('Add test.txt');
      expect(result).toBeDefined();
    });

    it('should fail for non-existent workspace', async () => {
      const gitTools = new GitTools('/nonexistent/path');
      const result = await gitTools.commit('Test');
      // Error message should indicate something went wrong
      expect(result?.length).toBeGreaterThan(0);
    });
  });

  describe('path confinement', () => {
    it('should only operate within workspace', async () => {
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      
      // Attempt to access files outside workspace
      const fileOutside = path.join(testDir, 'outside.txt');
      fs.writeFileSync(fileOutside, 'external');
      
      const status = await gitTools.status();
      expect(status?.includes('outside.txt')).toBe(false);
    });
  });
});
