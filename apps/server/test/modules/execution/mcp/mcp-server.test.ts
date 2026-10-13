import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import type { ProjectConfigV1 } from '../../../../src/platform/config/project-config.js';

function approvedProjectConfig(commands: NonNullable<ProjectConfigV1['execution']['commands']>): NonNullable<import('../../../../src/modules/execution/run-capability.js').RunCapabilityDef['approvedProjectConfig']> {
  return {
    revisionId: 'approved-revision',
    revisionHash: 'a'.repeat(64),
    config: {
      schema_version: 1,
      project: { name: 'test-project', default_branch: 'master' },
      execution: { mode: 'local', commands },
    },
    files: {},
  };
}

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

    it('documents paths-only search and exact patch range semantics in tools/list', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'workspace-tool-contracts', role: 'developer', workspace: workspaceDir,
        allowedTools: ['workspace.read', 'workspace.search', 'workspace.patch'],
      }));
      const listed = await server.processRequest({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) as {
        result: { tools: Array<{ name: string; description: string }> };
      };
      const descriptions = new Map(listed.result.tools.map(({ name, description }) => [name, description]));
      expect(descriptions.get('workspace.search')).toContain('file paths only');
      expect(descriptions.get('workspace.patch')).toContain('zero-based UTF-16');
      expect(descriptions.get('workspace.patch')).toContain('end-exclusive [start,end)');
      expect(descriptions.get('workspace.patch')).toContain('ascending non-overlapping replacements');
      expect(descriptions.get('workspace.patch')).toContain('content replaces each range');
    });

    it('publishes capability-bound git.add and read-only git.head tools when explicitly allowed', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'developer-git-surface', role: 'developer', workspace: workspaceDir,
        allowedTools: ['git.add', 'git.commit', 'git.head'],
      }));

      const listed = await server.processRequest({ jsonrpc: '2.0', id: 18, method: 'tools/list' }) as {
        result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }> };
      };
      expect(listed.result.tools.map(({ name }) => name)).toEqual(['git.add', 'git.commit', 'git.head']);
      expect(listed.result.tools.find(({ name }) => name === 'git.add')?.inputSchema).toMatchObject({
        properties: { paths: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['paths'],
      });
      expect(listed.result.tools.find(({ name }) => name === 'git.head')?.inputSchema).toMatchObject({ properties: {} });

      const { GitTools } = await import('../../../../src/modules/execution/git-tools.js');
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      execFileSync('git', ['-C', workspaceDir, 'config', '--local', 'user.name', 'MCP Test']);
      execFileSync('git', ['-C', workspaceDir, 'config', '--local', 'user.email', 'mcp-test@example.invalid']);
      fs.writeFileSync(path.join(workspaceDir, 'health.ts'), 'export const health = true;');
      await expect(server.callTool('git.add', { paths: ['health.ts'] })).resolves.toMatchObject({ success: true });
      await expect(server.callTool('git.commit', { message: 'Add health route' })).resolves.toMatchObject({ success: true });
      const head = await server.callTool('git.head', {});
      expect(head).toMatchObject({ success: true });
      expect(head.result).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu);
      await expect(server.callTool('git.add', { paths: ['../outside.txt'] })).resolves.toMatchObject({
        success: false, error: 'git add rejected paths or failed',
      });

      const noRepo = new McpServer(new RunCapability({
        id: 'developer-git-commit-failure', role: 'developer', workspace: path.join(testDir, 'no-repository'),
        allowedTools: ['git.commit'],
      }));
      fs.mkdirSync(path.join(testDir, 'no-repository'), { recursive: true });
      await expect(noRepo.callTool('git.commit', { message: 'Must fail safely' })).resolves.toEqual({
        success: false, error: 'git commit failed',
      });
    });

    it('publishes the canonical role output schema for submit_result and returns safe schema rejection details', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'role-schema', role: 'developer', workspace: workspaceDir, allowedTools: ['submit_result'],
      }));

      const listed = await server.processRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as {
        result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
      };
      const submitTool = listed.result.tools.find(({ name }) => name === 'submit_result');
      expect(submitTool).toBeDefined();
      const developerPayloadSchema = submitTool?.inputSchema.properties.payload as {
        oneOf: Array<{ properties: Record<string, unknown>; required: string[] }>;
      };
      expect(developerPayloadSchema.oneOf).toHaveLength(2);
      const completedSchema = developerPayloadSchema.oneOf.find((branch) =>
        (branch.properties.outcome as { const?: string }).const === 'COMPLETED');
      const blockedSchema = developerPayloadSchema.oneOf.find((branch) =>
        (branch.properties.outcome as { const?: string }).const === 'BLOCKED');
      expect(completedSchema?.required).toContain('commitSha');
      expect(completedSchema?.properties.commitSha).toMatchObject({ type: 'string', minLength: 1, pattern: '\\S' });
      expect(blockedSchema?.required).not.toContain('commitSha');
      expect(blockedSchema?.properties.commitSha).toMatchObject({ type: 'string', minLength: 1, pattern: '\\S' });
      expect((completedSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect((blockedSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);

      for (const [role, outcomes] of [
        ['reviewer', ['PASS', 'CHANGES_REQUESTED', 'BLOCKED']],
        ['qa', ['PASS', 'FAIL', 'BLOCKED']],
        ['integration', ['PASS', 'BLOCKED']],
      ] as const) {
        const roleServer = new McpServer(new RunCapability({
          id: `role-schema-${role}`, role, workspace: workspaceDir, allowedTools: ['submit_result'],
        }));
        const roleListing = await roleServer.processRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as {
          result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
        };
        const roleTool = roleListing.result.tools.find(({ name }) => name === 'submit_result');
        const publishedSchema = JSON.stringify(roleTool?.inputSchema.properties.payload);
        for (const outcome of outcomes) expect(publishedSchema).toContain(outcome);
      }

      const rejected = await server.processRequest({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'submit_result', arguments: { payload: { version: '1.0.0', outcome: 'UNKNOWN' } } },
      }) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(rejected.result.isError).toBe(true);
      expect(rejected.result.content[0]?.text).toContain('schema validation failed');
      expect(rejected.result.content[0]?.text).toContain("Expected 'COMPLETED' | 'BLOCKED'");
      expect(rejected.result.content[0]?.text).not.toContain('Internal error');
    });

    it.each([
      ['PASS', { version: '1.0.0', outcome: 'PASS', baseSha: 'base-sha', sourceSha: 'source-sha', provenance: ['merge verified'], evidence: ['pnpm test passed'] }],
      ['BLOCKED', { version: '1.0.0', outcome: 'BLOCKED' }],
    ])('accepts canonical Integration %s output through MCP tools/call', async (_label, payload) => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: `integration-${payload.outcome}`, role: 'integration', workspace: workspaceDir, allowedTools: ['submit_result'],
      }));

      const response = await server.processRequest({
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'submit_result', arguments: { payload } },
      }) as { result: { isError: boolean; content: Array<{ text: string }> } };

      expect(response.result.isError).toBe(false);
      expect(JSON.parse(response.result.content[0]!.text)).toEqual(payload);
    });

    it('rejects invalid Integration output through canonical role validation', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'integration-invalid', role: 'integration', workspace: workspaceDir, allowedTools: ['submit_result'],
      }));

      const response = await server.processRequest({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'submit_result', arguments: { payload: { version: '1.0.0', outcome: 'PASS' } } },
      }) as { result: { isError: boolean; content: Array<{ text: string }> } };

      expect(response.result.isError).toBe(true);
      expect(response.result.content[0]?.text).toContain('schema validation failed');
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
      const { GitTools } = await import('../../../../src/modules/execution/git-tools.js');
      const gitTools = new GitTools(workspaceDir);
      await gitTools.initRepo();
      execFileSync('git', ['-C', workspaceDir, 'config', '--local', 'user.name', 'MCP Test']);
      execFileSync('git', ['-C', workspaceDir, 'config', '--local', 'user.email', 'mcp-test@example.invalid']);
      const server = new McpServer(new RunCapability({
        id: 'schema-valid', role: 'developer', workspace: workspaceDir,
        allowedTools: ['workspace.read', 'workspace.patch', 'git.commit'],
      }));

      await expect(server.callTool('workspace.read', { path: 'file.txt' })).resolves.toMatchObject({ success: true });
      await expect(server.callTool('workspace.patch', {
        path: 'file.txt', patches: [{ start: 0, end: 5, content: 'world' }],
      })).resolves.toMatchObject({ success: true });
      expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('world');
      await gitTools.add(['file.txt']);
      await expect(server.callTool('git.commit', { message: 'validation test' })).resolves.toMatchObject({ success: true });
    });

    it.each(['hello\nworld', ''])('transports actual workspace.read content over JSON-RPC (%j)', async (content) => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      fs.writeFileSync(path.join(workspaceDir, 'file.txt'), content);
      const server = new McpServer(new RunCapability({
        id: 'wire-read', role: 'developer', workspace: workspaceDir, allowedTools: ['workspace.read'],
      }));
      const response = await server.processRequest({
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'workspace.read', arguments: { path: 'file.txt' } },
      });
      const wire = JSON.parse(JSON.stringify(response)) as { result: { isError: boolean; content: Array<{ type: string; text: string }> } };
      expect(wire.result.isError).toBe(false);
      expect(wire.result.content[0]).toEqual({ type: 'text', text: content });
    });

    it('transports a serializable workspace.patch acknowledgement over JSON-RPC', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'hello');
      const server = new McpServer(new RunCapability({
        id: 'wire-patch', role: 'developer', workspace: workspaceDir, allowedTools: ['workspace.patch'],
      }));
      const response = await server.processRequest({
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        params: { name: 'workspace.patch', arguments: { path: 'file.txt', patches: [{ start: 0, end: 5, content: 'world' }] } },
      });
      const wire = JSON.parse(JSON.stringify(response)) as { result: { isError: boolean; content: Array<{ type: string; text: string }> } };
      expect(wire.result.isError).toBe(false);
      expect(wire.result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ success: true }) });
      expect(JSON.parse(wire.result.content[0]!.text)).toEqual({ success: true });
      expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('world');
    });

    it.each([
      ['workspace.read', { path: 'missing.txt' }],
      ['workspace.patch', { path: 'file.txt', patches: [{ start: 0, end: 99, content: 'world' }] }],
    ] as const)('preserves %s failures over JSON-RPC', async (name, args) => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      fs.writeFileSync(path.join(workspaceDir, 'file.txt'), 'hello');
      const server = new McpServer(new RunCapability({
        id: 'wire-workspace-error', role: 'developer', workspace: workspaceDir, allowedTools: ['workspace.read', 'workspace.patch'],
      }));
      const response = await server.processRequest({
        jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name, arguments: args },
      });
      const wire = JSON.parse(JSON.stringify(response)) as { result: { isError: boolean; content: Array<{ type: string; text: string }> } };
      expect(wire.result.isError).toBe(true);
      expect(wire.result.content[0]).toMatchObject({ type: 'text', text: expect.any(String) });
      expect(JSON.parse(wire.result.content[0]!.text)).toEqual({ error: expect.any(String) });
      expect(fs.readFileSync(path.join(workspaceDir, 'file.txt'), 'utf8')).toBe('hello');
    });

    it('returns an internal error for runtime failures without mislabeling them as parse errors', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability(
        { id: 'runtime-error', role: 'reviewer', workspace: workspaceDir, allowedTools: ['project.test'] },
      ));
      server.getRegistry().getTool = () => { throw new Error('runtime failure'); };
      await expect(server.processRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project.test' } })).resolves.toMatchObject({
        jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'An internal error occurred' },
      });
      await expect(server.processRequest({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'project.test' } })).resolves.toBeNull();
    });

    it('redacts secrets from JSON-RPC errors and diagnostics while preserving code and request correlation', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability(
        { id: 'redaction-run', role: 'reviewer', workspace: workspaceDir, allowedTools: ['project.test'] },
      ));
      const absolutePath = path.join(testDir, 'private', 'database.sqlite');
      const sql = 'SELECT api_token FROM private_credentials';
      const token = 'sk-live-secret-4f2a';
      const internal = new Error(`${absolutePath} ${sql}`, { cause: new Error(token) });
      server.getRegistry().getTool = () => { throw internal; };
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const response = await server.processRequest({
          jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'project.test' },
        });
        const serialized = JSON.stringify(response);
        expect(response).toMatchObject({
          jsonrpc: '2.0', id: 42,
          error: { code: -32603, message: 'An internal error occurred', data: {
            code: 'internal_error', correlationId: expect.any(String),
          } },
        });
        const errorData = (response as { error: { data: { correlationId: string } } }).error.data;
        expect(errorData.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
        for (const secret of [absolutePath, sql, token]) expect(serialized).not.toContain(secret);
        const diagnostics = log.mock.calls.flat().join(' ');
        for (const secret of [absolutePath, sql, token]) expect(diagnostics).not.toContain(secret);
        expect(diagnostics).toContain(errorData.correlationId);
        expect(diagnostics).toContain('error_kind=error');
      } finally {
        log.mockRestore();
      }
    });

    it('runs project.test through the configured controlled executor', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'project-test', role: 'reviewer', workspace: workspaceDir,
        allowedTools: ['project.test'],
        approvedProjectConfig: approvedProjectConfig({ test: { executable: process.execPath, args: ['-e', 'process.stdout.write("real test")'] } }),
      }));
      const result = await server.callTool('project.test', {});
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ action: 'test', stdout: 'real test', exitCode: 0 });
    });

    it('returns a completed failing test as a readable tool result', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'project-test-failed-exit', role: 'developer', workspace: workspaceDir,
        allowedTools: ['project.test'],
        approvedProjectConfig: approvedProjectConfig({ test: { executable: process.execPath, args: [
          '-e', 'process.stdout.write("baseline stdout"); process.stderr.write("baseline stderr"); process.exit(1)',
        ] } }),
      }));

      const result = await server.callTool('project.test', {});
      expect(result).toMatchObject({
        success: false,
        result: { action: 'test', success: false, stdout: 'baseline stdout', stderr: 'baseline stderr', exitCode: 1 },
      });
      expect(result.error).toContain('baseline stderr');

      const rpc = await server.processRequest({
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'project.test' },
      });
      const rpcResult = (rpc as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      expect(rpcResult.isError).toBe(true);
      expect(JSON.parse(rpcResult.content[0]!.text)).toMatchObject({ success: false, exitCode: 1 });
    });

    it('keeps project.test tool failures for actions without a process exit code', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'project-test-unconfigured', role: 'developer', workspace: workspaceDir,
        allowedTools: ['project.test'], projectConfig: { commands: {} },
      }));

      const result = await server.callTool('project.test', {});
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('project test is not configured') });
    });

    it.each([
      ['project.lint', 'lint'],
      ['project.typecheck', 'typecheck'],
      ['project.build', 'build'],
    ] as const)('runs %s through the configured controlled executor', async (toolName, action) => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: `project-${action}`, role: 'developer', workspace: workspaceDir,
        allowedTools: [toolName],
        approvedProjectConfig: approvedProjectConfig({ [action]: { executable: process.execPath, args: ['-e', `process.stdout.write("${action}")`] } }),
      }));

      const result = await server.callTool(toolName, {});
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ action, stdout: action, exitCode: 0 });
    });

    it('runs command.exec without shell interpretation through the controlled executor', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'command-exec', role: 'developer', workspace: workspaceDir,
        allowedTools: ['command.exec'],
        projectConfig: { commands: {}, commandPolicies: [{
          id: 'node-version', executable: process.execPath,
          args: [{ type: 'string', enum: ['--version'] }],
          allowedRoots: [workspaceDir], timeout: 5_000, maxOutput: 1_024,
        }] },
      }));

      const result = await server.callTool('command.exec', {
        policyId: 'node-version',
        args: ['--version'],
      });
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ stdout: expect.stringMatching(/^v\d/), exitCode: 0 });

      const substituted = await server.callTool('command.exec', {
        policyId: 'node-version', executable: process.execPath, args: ['--version'],
      });
      expect(substituted).toMatchObject({ success: false, error: expect.stringContaining('unexpected') });
      const unknownPolicy = await server.callTool('command.exec', { policyId: 'unregistered', args: ['--version'] });
      expect(unknownPolicy).toMatchObject({ success: false });
    });

    it('does not expose command.exec when the capability declares no command policies', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      const server = new McpServer(new RunCapability({
        id: 'command-exec-unconfigured', role: 'developer', workspace: workspaceDir,
        allowedTools: ['command.exec'],
      }));

      expect(server.getAvailableTools().some((tool) => tool.name === 'command.exec')).toBe(false);
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
      expect(result.error).toContain('Unrecognized key: "invalidField"');
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
          commitSha: 'abc123',
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

    it('allows a retry when submit_result handler throws before accepting the result', async () => {
      const { McpServer } = await import('../../../../src/modules/execution/mcp/mcp-server.js');
      const { RunCapability } = await import('../../../../src/modules/execution/run-capability.js');
      let attempts = 0;
      const completion = {
        accept: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary completion store failure');
          return true;
        },
      };
      const server = new McpServer(new RunCapability({
        id: 'retry-ref', capabilityRef: 'retry-ref', runId: 'run-retry', role: 'reviewer',
        workspace: workspaceDir, allowedTools: ['submit_result'],
      }), { completion });

      await expect(server.callTool('submit_result', { payload: { version: '1.0', outcome: 'PASS' } }))
        .rejects.toThrow('temporary completion store failure');
      await expect(server.callTool('submit_result', { payload: { version: '1.0', outcome: 'PASS' } }))
        .resolves.toMatchObject({ success: true });
      expect(attempts).toBe(2);
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
