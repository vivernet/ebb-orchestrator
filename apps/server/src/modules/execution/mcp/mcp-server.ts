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

/**
 * Mapped public error types that can be safely exposed in JSON-RPC responses.
 * Internal error details must NEVER be exposed in the response.
 */
export const PublicErrorCode = {
  INTERNAL: 'internal_error',
  CAPABILITY_REVOKED: 'capability_revoked',
  TOOL_NOT_FOUND: 'tool_not_found',
  RUN_ALREADY_COMPLETING: 'run_already_completing',
  INVALID_TOOL_ARGS: 'invalid_tool_args',
} as const;

export type PublicErrorCode = typeof PublicErrorCode[keyof typeof PublicErrorCode];

interface PublicError {
  code: PublicErrorCode;
  message: string; // Human-friendly description without internal details
}

/**
 * Maps internal exceptions to stable public JSON-RPC error responses.
 * Logs correlation-safe diagnostics server-side without exposing secrets or internals.
 */
const mapPublicError = (error: unknown, runId: string): PublicError => {
  // Log correlation-safe diagnostic server-side (never expose in response)
  const safeMsg = error instanceof Error ? error.message : String(error);
  console.error(`[MCP ${runId}] Internal error: ${safeMsg}`);

  if (error instanceof Error) {
    // Map known internal error codes to public equivalents
    if (safeMsg.startsWith('RUN_ALREADY_COMPLETING')) {
      return { code: PublicErrorCode.RUN_ALREADY_COMPLETING, message: 'RUN_ALREADY_COMPLETING: Tool calls are not allowed after submit_result has been called' };
    }
    if (safeMsg.startsWith('capability revoked') || safeMsg.includes('unauthorized')) {
      return { code: PublicErrorCode.CAPABILITY_REVOKED, message: 'This capability has been revoked' };
    }
    if (safeMsg.includes('tool not found')) {
      return { code: PublicErrorCode.TOOL_NOT_FOUND, message: 'The requested tool does not exist' };
    }
    if (safeMsg.includes('invalid tool arguments')) {
      return { code: PublicErrorCode.INVALID_TOOL_ARGS, message: 'The provided arguments do not match the tool schema' };
    }
  }
  // Default: generic internal error with no internal details exposed
  return { code: PublicErrorCode.INTERNAL, message: 'An internal error occurred' };
};

/**
 * Returns a safe error string for ToolCallResult that can be exposed to the caller.
 * Raw error messages are replaced with safe public-facing messages.
 */
const safeErrorMessage = (error: unknown, runId: string): string => {
  const { message } = mapPublicError(error, runId);
  return message;
};

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
 * McpServer provides Объект MCP stdio сервер реализация который routes инструмент calls
 * through ActionGateway using capability-bound инструмент access.
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
   * Call Объект инструмент by name с аргументы.
   * Никогда trusts task/workspace IDs from model payload - resolves server-side.
   */
  async callTool(name: string, args: unknown): Promise<ToolCallResult> {
    try { this.capability.revalidateAccess(); } catch (error) { return { success: false, error: safeErrorMessage(error, this.runId) }; }
    // Получает the tool definition
    const tool = this.registry.getTool(name);
    if (!tool) {
      return { success: false, error: safeErrorMessage(new Error(`tool not found: ${name}`), this.runId) };
    }

    const validatedArgs = validateToolArguments(tool.inputSchema, args);
    if (typeof validatedArgs === 'string') return { success: false, error: `invalid tool arguments: ${validatedArgs}` };

    // Проверяет if submit_result has already been called - blocks all write-capable tools
    if (this.hasSubmittedResult || this.submittingResult) {
      return { success: false, error: safeErrorMessage(new Error('RUN_ALREADY_COMPLETING'), this.runId) };
    }

    // Call Объект инструмент handler
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
   * процесс Объект MCP запрос.
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
    const publicErr = mapPublicError(error, this.runId);
    return respond(errorResponse(id ?? null, -32603, publicErr.message));
    }
  }
}
