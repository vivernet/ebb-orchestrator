import { RunCapability } from '../run-capability.js';
import { ToolRegistry } from './tool-registry.js';
import type { CompletionStore } from './submit-result-tool.js';

/**
 * Result of a tool call.
 */
export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

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
  getAvailableTools(): Array<{ name: string; description: string }> {
    return this.registry.getAvailableTools().map(tool => ({
      name: tool.name,
      description: tool.description,
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
  async processRequest(request: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<{ result: unknown; error?: string }> {
    switch (request.method) {
      case 'tools/list':
        return { result: this.getAvailableTools() };

      case 'tools/call': {
        const toolName = request.params?.name as string;
        const toolArgs = (request.params?.arguments as Record<string, unknown>) || {};
        const result = await this.callTool(toolName, toolArgs);
        return { result };
      }

      case 'initialize':
        return { result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orchestrator-mcp', version: '1.0.0' },
        }};

      default:
        return { result: {}, error: `unknown method: ${request.method}` };
    }
  }
}
