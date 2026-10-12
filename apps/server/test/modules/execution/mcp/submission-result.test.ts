import { describe, expect, it } from 'vitest';
import { McpServer } from '../../../../src/modules/execution/mcp/mcp-server.js';
import { extractSuccessfulSubmission } from '../../../../src/modules/execution/mcp/submission-result.js';
import { RunCapability } from '../../../../src/modules/execution/run-capability.js';

describe('extractSuccessfulSubmission', () => {
  it('extracts the role output nested in a successful MCP tools/call envelope', async () => {
    const server = new McpServer(new RunCapability({
      id: 'mcp-result-envelope', role: 'developer', workspace: process.cwd(), allowedTools: ['submit_result'],
    }));
    const response = await server.processRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'submit_result', arguments: { payload: { version: '1.0.0', outcome: 'COMPLETED', commitSha: 'abc123' } } },
    });

    expect(extractSuccessfulSubmission(response, 'developer')).toEqual({
      version: '1.0.0', outcome: 'COMPLETED', commitSha: 'abc123',
    });
  });

  it('does not extract an MCP tool error or an invalid role result', () => {
    expect(extractSuccessfulSubmission({
      result: { isError: true, content: [{ type: 'text', text: '{"success":true,"result":{"outcome":"PASS"}}' }] },
    }, 'developer')).toBeUndefined();
    expect(extractSuccessfulSubmission({
      result: { isError: false, content: [{ type: 'text', text: '{"success":true,"result":{"outcome":"PASS"}}' }] },
    }, 'developer')).toBeUndefined();
  });
});
