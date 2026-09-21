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
// Игнорируем ошибки очистки.
    }
  });

  describe('tool filtering', () => {
    it('returns MCP descriptors with input schemas through the JSON-RPC handshake', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({ id: 'handshake', role: 'reviewer', workspace: workspaceDir, allowedTools: ['workspace.read', 'submit_result'] }));
       const initialize = await server.processRequest({ jsonrpc: '2.0', id: 7, method: 'initialize' });
       const listed = await server.processRequest({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
       expect(initialize).not.toBeNull();
       expect(listed).not.toBeNull();
       expect(initialize as object).toMatchObject({ jsonrpc: '2.0', id: 7 });
       expect(listed as object).toMatchObject({ jsonrpc: '2.0', id: 8 });
       const initializeResponse = initialize as { result: { protocolVersion: string } };
       const listedResponse = listed as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } };
       expect(initializeResponse.result).toMatchObject({ protocolVersion: expect.any(String) });
       const tools = listedResponse.result.tools;
      expect(tools).toHaveLength(2);
      for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
    });

    it('implements JSON-RPC errors, params validation, and silent notifications', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({ id: 'protocol', role: 'reviewer', workspace: workspaceDir, allowedTools: ['project.test'] }));
      await expect(server.processRequest({ jsonrpc: '2.0', id: 1, method: 'missing' })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 1, error: { code: -32601 },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 2, error: { code: -32602 },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', method: 'tools/list' })).resolves.toBeNull();
      await expect(server.processRequest({ jsonrpc: '1.0', id: 3, method: 'tools/list' })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 3, error: { code: -32600 },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', method: 'tools/call', params: {} })).resolves.toBeNull();
      await expect(server.processRequest({ jsonrpc: '2.0', method: 'tools/list', params: [] })).resolves.toBeNull();
      await expect(server.processRequest({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: [] })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 5, error: { code: -32602 },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', id: 'request-id', method: 'tools/call', params: [] })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 'request-id', error: { code: -32602 },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', id: null, method: 'tools/list' })).resolves.toMatchObject({
        jsonrpc: '2.0', id: null, result: expect.any(Object),
      });
    });

    it('rejects tool arguments that violate the declared input schemas before dispatch', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'schema-validation', role: 'developer', workspace: workspaceDir,
        allowedTools: ['workspace.read', 'workspace.patch', 'git.commit'],
      }));
      fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'hello');

      await expect(server.callTool('workspace.read', {})).resolves.toMatchObject({
        success: false, error: expect.stringContaining('missing required property: path'),
      });
      await expect(server.callTool('workspace.read', { path: 42 })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('path must be a string'),
      });
      await expect(server.callTool('workspace.read', { path: 'file.txt', extra: true })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('unexpected property: extra'),
      });
      await expect(server.callTool('git.commit', { message: ['not', 'a', 'message'] })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('message must be a string'),
      });
      await expect(server.callTool('workspace.patch', { path: 'file.txt', patches: {} })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('patches must be an array'),
      });
      await expect(server.callTool('workspace.patch', {
        path: 'file.txt', patches: [{ start: 'bad', end: 0, content: 'X' }],
      })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('patches[0].start must be a number'),
      });
      expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('hello');
      await expect(server.callTool('workspace.patch', { path: 'file.txt' })).resolves.toMatchObject({
        success: false, error: expect.stringContaining('missing required property: patches'),
      });
    });

    it('preserves valid schema-conforming path, patch, and message calls', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'hello');
      const server = new McpServer(new RunCapability({
        id: 'schema-valid', role: 'developer', workspace: workspaceDir,
        allowedTools: ['workspace.read', 'workspace.patch', 'git.commit'],
      }));

      await expect(server.callTool('workspace.read', { path: 'file.txt' })).resolves.toMatchObject({ success: true });
      await expect(server.callTool('workspace.patch', {
        path: 'file.txt', patches: [{ start: 0, end: 5, content: 'world' }],
      })).resolves.toMatchObject({ success: true });
      expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('world');
      await expect(server.callTool('git.commit', { message: 'validation test' })).resolves.toMatchObject({ success: true });
    });

    it('returns an internal error for runtime failures without mislabeling them as parse errors', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability(
        { id: 'runtime-error', role: 'reviewer', workspace: workspaceDir, allowedTools: ['project.test'] },
      ));
      server.getRegistry().getTool = () => { throw new Error('runtime failure'); };
      await expect(server.processRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project.test' } })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'Internal error' },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'project.test' } })).resolves.toBeNull();
    });

    it('runs project.test through the configured controlled executor', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'project-test', role: 'reviewer', workspace: workspaceDir,
        allowedTools: ['project.test'],
        projectConfig: { commands: { test: { executable: process.execPath, args: ['-e', 'process.stdout.write("real test")'] } } },
      }));
      const result = await server.callTool('project.test', {});
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ action: 'test', stdout: 'real test', exitCode: 0 });
    });

    it('should instantiate MCP server for Reviewer capability and filter tools correctly', async () => {
// Импортируем модули.
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

// Создаём capability Reviewer с разрешёнными инструментами.
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

// Должны присутствовать только read/search/diff/test/submit.
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

// Reviewer НЕ должен иметь инструментов, выполняющих запись.
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
      
// Первый вызов должен быть успешным.
      const firstResult = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
        },
      });

      expect(firstResult.success).toBe(true);

// Второй вызов должен завершиться ошибкой RUN_ALREADY_COMPLETING.
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
      
// Некорректный payload должен отклоняться.
      const result = await mcpServer.callTool('submit_result', {
        payload: {
          invalidField: 'test',
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('schema');
    });

    it('should block write-capable tools after submit_result', async () => {
      const mcpModule = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const capabilityModule = await import('../../../../src/modules/execution/run-capability.js');

      const McpServer = mcpModule.McpServer;
      const RunCapability = capabilityModule.RunCapability;

      const capability = new RunCapability({
        id: 'test-capability',
        role: 'developer',
        workspace: workspaceDir,
        allowedTools: [
          'workspace.read',
          'workspace.patch',
          'submit_result',
        ],
      });

      const mcpServer = new McpServer(capability);
      
// Первый submit_result должен быть успешным.
      const submitResult = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'COMPLETED',
        },
      });

      expect(submitResult.success).toBe(true);

// После submit_result инструмент записи должен быть заблокирован.
      const patchResult = await mcpServer.callTool('workspace.patch', {
        path: 'test.txt',
        patches: [],
      });

      expect(patchResult.success).toBe(false);
      expect(patchResult.error).toContain('RUN_ALREADY_COMPLETING');
    });
  });

  describe('security', () => {
    it('accepts only the issued run reference and atomically rejects duplicates', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const accepted: string[] = [];
      const completion = {
        accept: async (reference: string, value: { runId: string; role: string; output: unknown }) => {
          if (reference !== 'issued-ref' || value.runId !== 'run-1' || value.role !== 'reviewer' || accepted.length) return false;
          accepted.push(reference);
          return true;
        },
      };
      const server = new McpServer(new RunCapability({ id: 'issued-ref', capabilityRef: 'issued-ref', runId: 'run-1', role: 'reviewer', workspace: workspaceDir, allowedTools: ['submit_result'] }), { completion });
      expect((await server.callTool('submit_result', { payload: { version: '1.0', outcome: 'PASS' } })).success).toBe(true);
      expect((await server.callTool('submit_result', { payload: { version: '1.0', outcome: 'PASS' } })).error).toContain('RUN_ALREADY_COMPLETING');
      expect(accepted).toHaveLength(1);
    });

    it('rejects a capability bound to a different run or role', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const completion = { accept: async () => false };
      expect(() => new McpServer(new RunCapability({ id: 'wrong', runId: 'run-2', role: 'developer', workspace: workspaceDir, allowedTools: ['submit_result'] }), { completion, expectedRunId: 'run-1', expectedRole: 'reviewer' })).toThrow('unauthorized');
    });

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
      
// Нельзя использовать task/workspace IDs из payload.
      const result = await mcpServer.callTool('submit_result', {
        payload: {
          version: '1.0',
          outcome: 'PASS',
          taskId: 'malicious_task_id',
          workspace: '/etc/passwd',
        },
      });

// Если проверка схемы успешна, workspace ID должен игнорироваться.
      expect(result.success).toBe(false); // Invalid schema
    });
  });
});
