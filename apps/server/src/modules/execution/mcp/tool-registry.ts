import { RunCapability } from '../run-capability.js';
import type { ToolId } from '../run-capability.js';
import { SubmitResultTool, type CompletionStore } from './submit-result-tool.js';

/**
 * Tool definition for MCP.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  handler: (args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
}

/**
 * ToolRegistry maps capability tools to MCP tool definitions and filters by allowed tools.
 */
export class ToolRegistry {
  private toolDefinitions: Map<ToolId, ToolDefinition> = new Map();
  private capability: RunCapability;

  constructor(capability: RunCapability, completion?: CompletionStore) {
    this.capability = capability;
    // Register workspace.read
    this.toolDefinitions.set('workspace.read', {
      name: 'workspace.read',
      description: 'Read a file from the workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      handler: async (args) => {
        const result = await capability.getActionGateway().readFile(args.path as string);
        return result;
      },
    });

    // Register workspace.search
    this.toolDefinitions.set('workspace.search', {
      name: 'workspace.search',
      description: 'Search for patterns in the workspace',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, ext: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
      handler: async (args) => {
        const results = await capability.getActionGateway().search(
          args.pattern as string,
          args.ext as string | undefined
        );
        return { success: true, result: results };
      },
    });

    // Register workspace.patch (write-capable)
    this.toolDefinitions.set('workspace.patch', {
      name: 'workspace.patch',
      description: 'Patch a file in the workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, patches: { type: 'array' } }, required: ['path', 'patches'], additionalProperties: false },
      handler: async (args) => {
        const result = await capability.getActionGateway().patch(
          args.path as string,
          args.patches as Array<{ start: number; end: number; content: string }>
        );
        return result;
      },
    });

    // Register git.diff
    this.toolDefinitions.set('git.diff', {
      name: 'git.diff',
      description: 'Get git diff',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args) => {
        const gitTools = this.capability.getGitTools();
        if (!gitTools) {
          return { success: false, error: 'git not available' };
        }
        const result = await gitTools.diff();
        return { success: true, result };
      },
    });

    // Register git.status
    this.toolDefinitions.set('git.status', {
      name: 'git.status',
      description: 'Get git status',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args) => {
        const gitTools = this.capability.getGitTools();
        if (!gitTools) {
          return { success: false, error: 'git not available' };
        }
        const result = await gitTools.status();
        return { success: true, result };
      },
    });

    // Register git.commit
    this.toolDefinitions.set('git.commit', {
      name: 'git.commit',
      description: 'Commit changes',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
      handler: async (args) => {
        const gitTools = this.capability.getGitTools();
        if (!gitTools) {
          return { success: false, error: 'git not available' };
        }
        const message = args.message as string;
        const result = await gitTools.commit(message);
        return { success: true, result };
      },
    });

    // Register project.test
    this.toolDefinitions.set('project.test', {
      name: 'project.test',
      description: 'Run project tests',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (args) => {
        if (Object.keys(args).length !== 0) {
          return { success: false, error: 'invalid project.test arguments' };
        }
        const result = await capability.getActionGateway().test();
        return { success: result.success, result, ...(result.success ? {} : { error: result.stderr }) };
      },
    });

    // Register submit_result
    const submitTool = new SubmitResultTool(capability, completion);
    this.toolDefinitions.set('submit_result' as ToolId, {
      name: 'submit_result',
      description: 'Submit agent result and finalize run',
      inputSchema: { type: 'object', properties: { payload: { type: 'object' } }, required: ['payload'], additionalProperties: false },
      handler: async (args) => {
        const result = await submitTool.validateAndSubmit(args.payload);
        return result;
      },
    });
  }

  /**
   * Get all tools available for this capability.
   */
  getAvailableTools(): ToolDefinition[] {
    const allowedTools = this.capability.capability.allowedTools;
    const tools: ToolDefinition[] = [];

    for (const toolId of allowedTools) {
      const definition = this.toolDefinitions.get(toolId);
      if (definition) {
        tools.push(definition);
      }
    }

    return tools;
  }

  /**
   * Get a tool by name.
   */
  getTool(name: string): ToolDefinition | undefined {
    for (const [toolId, definition] of this.toolDefinitions.entries()) {
      if (definition.name === name && this.capability.isToolAllowed(toolId)) {
        return definition;
      }
    }
    return undefined;
  }
}
