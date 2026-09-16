import { RunCapability } from '../run-capability.js';
import { ToolRegistry } from './tool-registry.js';

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

  constructor(capability: RunCapability) {
    this.capability = capability;
    this.registry = new ToolRegistry(capability);
    this.runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    if (this.hasSubmittedResult) {
      return {
        success: false,
        error: 'RUN_ALREADY_COMPLETING: no further tool calls allowed after submit_result',
      };
    }

    // Call the tool handler
    const result = await tool.handler(args);

    // Track successful submit_result call
    if (name === 'submit_result' && result.success) {
      this.hasSubmittedResult = true;
    }

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
