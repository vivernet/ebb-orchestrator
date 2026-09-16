import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';

describe('MCP Server', () => {
  let testDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `mcp-test-${crypto.randomBytes(4).toString('hex')}`);
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

  describe('tool filtering', () => {
    it('should instantiate MCP server for Reviewer capability and filter tools correctly', async () => {
      // Import modules
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      // Create a Reviewer capability with allowed tools
      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'workspace.search',
          'git.diff',
          'project.test',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      const tools = mcpServer.getAvailableTools();

      // Should contain only read/search/diff/test/submit
      expect(tools.map(t => t.name)).toEqual([
        'workspace.read',
        'workspace.search',
        'git.diff',
        'project.test',
        'submit_result',
      ]);
    });

    it('should exclude write-capable tools from Reviewer', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'workspace.search',
          'git.diff',
          'project.test',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      const tools = mcpServer.getAvailableTools();
      const toolNames = tools.map(t => t.name);

      // Reviewer should NOT have write-capable tools
      expect(toolNames).not.toContain('workspace.patch');
      expect(toolNames).not.toContain('git.commit');
      expect(toolNames).not.toContain('git.status');
    });
  });

  describe('submit_result lifecycle', () => {
    it('should allow first submit_result call', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'workspace.search',
          'git.diff',
          'project.test',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      const result = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should block second submit_result call', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'workspace.search',
          'git.diff',
          'project.test',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      
      // First call should succeed
      const firstResult = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
        },
      });

      expect(firstResult.success).toBe(true);

      // Second call should fail with RUN_ALREADY_COMPLETING
      const secondResult = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
        },
      });

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain('RUN_ALREADY_COMPLETING');
    });

    it('should validate role output schema', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      
      // Invalid payload should fail
      const result = await mcpServer.callTool('submit_result', {
        payload: {
          invalidField: 'test',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('schema');
    });
  });

  describe('security', () => {
    it('should never trust task/workspace IDs from model payload', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'reviewer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      
      // Should not use task/workspace IDs from payload
      const result = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
          taskId: 'malicious_task_id',
          workspace: '/etc/passwd',
        },
      });

      // If schema validation passes, workspace ID should be ignored
      expect(result.success).toBe(false); // Invalid schema
    });
  });
});
