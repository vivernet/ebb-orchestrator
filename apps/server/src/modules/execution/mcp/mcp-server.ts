import { RunCapability } from '../run-capability.js';
import { ToolRegistry, type SchemaDefinition, type ToolDefinition } from './tool-registry.js';
import type { CompletionStore } from './submit-result-tool.js';

/**
 * Результат of a tool call.
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
  params?: unknown;
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

const validateToolArguments = (
  schema: ToolDefinition['inputSchema'],
  value: unknown,
): Record<string, unknown> | string => {
  const validateValue = (definition: SchemaDefinition, candidate: unknown, path: string): string | undefined => {
    const validType = definition.type === 'object'
      ? isRecord(candidate)
      : definition.type === 'array'
        ? Array.isArray(candidate)
        : typeof candidate === definition.type;
    if (!validType) return `${path} must be ${definition.type === 'array' || definition.type === 'object' ? 'an' : 'a'} ${definition.type}`;

    if (definition.type === 'array' && definition.items && Array.isArray(candidate)) {
      for (const [index, item] of candidate.entries()) {
        const error = validateValue(definition.items, item, `${path}[${index}]`);
        if (error) return error;
      }
    }
    if (definition.type === 'object' && definition.properties && isRecord(candidate)) {
      for (const required of definition.required ?? []) {
        if (!(required in candidate)) return `${path} missing required property: ${required}`;
      }
      if (definition.additionalProperties === false) {
        for (const key of Object.keys(candidate)) {
          if (!(key in definition.properties)) return `${path} unexpected property: ${key}`;
        }
      }
      for (const [key, propertySchema] of Object.entries(definition.properties)) {
        if (key in candidate) {
          const error = validateValue(propertySchema, candidate[key], `${path}.${key}`);
          if (error) return error;
        }
      }
    }
    return undefined;
  };

  if (!isRecord(value)) return 'arguments must be an object';
  for (const required of schema.required ?? []) {
    if (!(required in value)) return `missing required property: ${required}`;
  }
  if (schema.additionalProperties === false) {
    const properties = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (!properties.has(key)) return `unexpected property: ${key}`;
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (key in value) {
      const error = validateValue(propertySchema, value[key], key);
      if (error) return error;
    }
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
   * Получает available tools for this capability.
   */
  getAvailableTools(): Array<Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>> {
    return this.registry.getAvailableTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Получает the tool registry for testing purposes.
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * Call a tool by name with arguments.
   * Никогда trusts task/workspace IDs from model payload - resolves server-side.
   */
  async callTool(name: string, args: unknown): Promise<ToolCallResult> {
    try { this.capability.revalidateAccess(); } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'capability revoked' }; }
    // Получает the tool definition
    const tool = this.registry.getTool(name);
    if (!tool) {
      return { success: false, error: `tool not found: ${name}` };
    }

    const validatedArgs = validateToolArguments(tool.inputSchema, args);
    if (typeof validatedArgs === 'string') return { success: false, error: `invalid tool arguments: ${validatedArgs}` };

    // Проверяет if submit_result has already been called - blocks all write-capable tools
    if (this.hasSubmittedResult || this.submittingResult) {
      return {
        success: false,
        error: 'RUN_ALREADY_COMPLETING: no further tool calls allowed after submit_result',
      };
    }

    // Call the tool handler
    if (name === 'submit_result') this.submittingResult = true;
    const result = await tool.handler(validatedArgs);

    // Отслеживает successful submit_result call
    if (name === 'submit_result' && result.success) {
      this.hasSubmittedResult = true;
    }
    if (name === 'submit_result' && !result.success) this.submittingResult = false;

    return result;
  }

  /**
   * Получает the run ID for this server instance.
   */
  getRunId(): string {
    return this.runId;
  }

  /**
   * Process an MCP request.
   */
  async processRequest(request: unknown): Promise<JsonRpcResponse | null> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
    const value = request as Record<string, unknown>;
    const id = value.id;
    const isNotification = id === undefined;
    if (value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0 ||
        (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') ||
        (typeof id === 'number' && !Number.isFinite(id))) {
      return isNotification
        ? null
        : errorResponse(id === null || typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request');
    }
    const requestValue = value as unknown as JsonRpcRequest;
    const respond = (response: JsonRpcResponse): JsonRpcResponse | null => isNotification ? null : response;
    if (requestValue.params !== undefined &&
        (!requestValue.params || typeof requestValue.params !== 'object' || Array.isArray(requestValue.params))) {
      return respond(errorResponse(id ?? null, -32602, 'Invalid params'));
    }
    try {
      switch (requestValue.method) {
        case 'tools/list':
          return respond({ jsonrpc: '2.0', id: id ?? null, result: { tools: this.getAvailableTools() } });

        case 'tools/call': {
          if (!requestValue.params || typeof requestValue.params !== 'object' || Array.isArray(requestValue.params) ||
              typeof (requestValue.params as Record<string, unknown>).name !== 'string' ||
              ((requestValue.params as Record<string, unknown>).arguments !== undefined &&
                (!(requestValue.params as Record<string, unknown>).arguments ||
                  typeof (requestValue.params as Record<string, unknown>).arguments !== 'object' ||
                  Array.isArray((requestValue.params as Record<string, unknown>).arguments)))) {
            return respond(errorResponse(id ?? null, -32602, 'Invalid params'));
          }
          const params = requestValue.params as Record<string, unknown>;
          const toolName = params.name as string;
          const toolArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};
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
            serverInfo: { name: 'ebb-orchestrator-mcp', version: '1.0.0' },
          }});

        default:
          return respond(errorResponse(id ?? null, -32601, `Method not found: ${requestValue.method}`));
      }
    } catch (error) {
      return respond(errorResponse(id ?? null, -32603, 'Internal error', error instanceof Error ? error.message : undefined));
    }
  }
}
