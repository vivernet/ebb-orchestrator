import { RunCapability } from '../run-capability.js';
import { ToolRegistry, type ToolDefinition } from './tool-registry.js';
import type { CompletionStore } from './submit-result-tool.js';

/**
 * Result of a tool call.
 */
export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

type JsonRpcId = string | number | null;
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: JsonRpcId;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const errorResponse = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * McpServer provides an MCP stdio server implementation that routes tool calls
 * through ActionGateway using capability-bound tool access.
 */
export class McpServer {
  private registry: ToolRegistry;
  private capability: RunCapability;
  private runId: string;
  private hasSubmittedResult: boolean = false;
  private submittingResult = false;

  constructor(capability: RunCapability, options: { completion?: CompletionStore; expectedRunId?: string; expectedRole?: string } = {}) {
    if (options.expectedRunId && options.expectedRunId !== capability.runId) throw new Error('unauthorized capability run');
    if (options.expectedRole && options.expectedRole.toLowerCase() !== capability.capability.role.toLowerCase()) throw new Error('unauthorized capability role');
    this.capability = capability;
    this.registry = new ToolRegistry(capability, options.completion);
    this.runId = capability.runId;
  }

  /**
   * Get available tools for this capability.
   */
  getAvailableTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
    return this.registry.getAvailableTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Get the tool registry for testing purposes.
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * Call a tool by name with arguments.
   * Never trusts task/workspace IDs from model payload - resolves server-side.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    try { this.capability.revalidateAccess(); } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'capability revoked' }; }
    // Get the tool definition
    const tool = this.registry.getTool(name);
    if (!tool) {
      return { success: false, error: `tool not found: ${name}` };
    }

    // Check if submit_result has already been called - blocks all write-capable tools
    if (this.hasSubmittedResult || this.submittingResult) {
      return {
        success: false,
        error: 'RUN_ALREADY_COMPLETING: no further tool calls allowed after submit_result',
      };
    }

    // Call the tool handler
    if (name === 'submit_result') this.submittingResult = true;
    const result = await tool.handler(args);

    // Track successful submit_result call
    if (name === 'submit_result' && result.success) {
      this.hasSubmittedResult = true;
    }
    if (name === 'submit_result' && !result.success) this.submittingResult = false;

    return result;
  }

  /**
   * Get the run ID for this server instance.
   */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Process an MCP request.
   */
  async processRequest(request: unknown): Promise<JsonRpcResponse | null> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return errorResponse(null, -32600, 'Invalid Request');
    const value = request as Record<string, unknown>;
    const id = value.id;
    const isNotification = id === undefined;
    if (value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0 ||
        (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') ||
        (typeof id === 'number' && !Number.isFinite(id)) ||
        (value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)))) {
      return errorResponse(id === null || typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request');
    }
    const requestValue = value as unknown as JsonRpcRequest;
    const respond = (response: JsonRpcResponse): JsonRpcResponse | null => isNotification ? null : response;
    switch (requestValue.method) {
      case 'tools/list':
        return respond({ jsonrpc: '2.0', id: id ?? null, result: { tools: this.getAvailableTools() } });

      case 'tools/call': {
        if (!requestValue.params || typeof requestValue.params.name !== 'string' ||
            (requestValue.params.arguments !== undefined && (!requestValue.params.arguments || typeof requestValue.params.arguments !== 'object' || Array.isArray(requestValue.params.arguments)))) {
          return respond(errorResponse(id ?? null, -32602, 'Invalid params'));
        }
        const toolName = requestValue.params.name;
        const toolArgs = (requestValue.params.arguments as Record<string, unknown> | undefined) ?? {};
        const result = await this.callTool(toolName, toolArgs);
        return respond({ jsonrpc: '2.0', id: id ?? null, result: {
          content: [{ type: 'text', text: JSON.stringify(result.success ? result.result : { error: result.error }) }],
          isError: result.success !== true,
        } });
      }

      case 'initialize':
        return respond({ jsonrpc: '2.0', id: id ?? null, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orchestrator-mcp', version: '1.0.0' },
        }});

      default:
        return respond(errorResponse(id ?? null, -32601, `Method not found: ${requestValue.method}`));
    }
  }
}
