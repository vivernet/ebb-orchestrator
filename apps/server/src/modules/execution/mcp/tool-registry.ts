import { RunCapability } from '../run-capability.js';
import type { ToolId } from '../run-capability.js';
import { SubmitResultTool, type CompletionStore } from './submit-result-tool.js';
import { getRoleOutputJsonSchema } from '../../runtime/output-validator.js';

/**
 * инструмент definition для MCP.
 */
export interface SchemaDefinition {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, SchemaDefinition>;
  items?: SchemaDefinition;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, SchemaDefinition>; required?: string[]; additionalProperties?: boolean };
  handler: (args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
}

interface FilePatch { start: number; end: number; content: string }
const isFilePatch = (value: unknown): value is FilePatch => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  return typeof patch.start === 'number' && typeof patch.end === 'number' && typeof patch.content === 'string' &&
    Object.keys(patch).every(key => key === 'start' || key === 'end' || key === 'content');
};

/**
 * ToolRegistry maps capability инструменты to MCP инструмент definitions и фильтрует by allowed инструменты.
 */
export class ToolRegistry {
  private toolDefinitions: Map<ToolId, ToolDefinition> = new Map();
  private capability: RunCapability;

  constructor(capability: RunCapability, completion?: CompletionStore) {
    this.capability = capability;
    // Register workspace.читает
    this.toolDefinitions.set('workspace.read', {
      name: 'workspace.read',
      description: 'Read a file from the workspace',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      handler: async (args) => {
        const result = await capability.getActionGateway().readFile(args.path as string);
        return result.success ? { success: true, result: result.content } : result;
      },
    });

    // Регистрирует workspace.search.
    this.toolDefinitions.set('workspace.search', {
      name: 'workspace.search',
      description: 'Search for patterns in the workspace; returns matching file paths only, not file contents',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, ext: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
      handler: async (args) => {
        const results = await capability.getActionGateway().search(
          args.pattern as string,
          args.ext as string | undefined
        );
        return { success: true, result: results };
      },
    });

    // Регистрирует workspace.patch (с возможностью записи).
    this.toolDefinitions.set('workspace.patch', {
      name: 'workspace.patch',
      description: 'Patch a file using zero-based UTF-16 offsets and end-exclusive [start,end) ranges; apply ascending non-overlapping replacements, where content replaces each range',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patches: {
            type: 'array',
            items: {
              type: 'object',
              properties: { start: { type: 'number' }, end: { type: 'number' }, content: { type: 'string' } },
              required: ['start', 'end', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'patches'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (typeof args.path !== 'string' || !Array.isArray(args.patches) || !args.patches.every(isFilePatch)) {
          return { success: false, error: 'invalid workspace.patch arguments' };
        }
        const result = await capability.getActionGateway().patch(args.path, args.patches);
        return result.success ? { success: true, result: { success: true } } : result;
      },
    });

    // Регистрирует git.diff.
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

    // Register git.статус
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

    this.toolDefinitions.set('git.add', {
      name: 'git.add',
      description: 'Stage explicitly listed relative workspace paths using literal Git pathspecs',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        required: ['paths'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const paths = args.paths as string[];
        try {
          const result = await capability.getGitTools()?.add(paths);
          if (result === undefined) return { success: false, error: 'git not available' };
          return { success: true, result };
        } catch {
          return { success: false, error: 'git add rejected paths or failed' };
        }
      },
    });

    // Регистрирует git.commit.
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
        try {
          const result = await gitTools.commit(message);
          return { success: true, result };
        } catch {
          return { success: false, error: 'git commit failed' };
        }
      },
    });

    this.toolDefinitions.set('git.head', {
      name: 'git.head',
      description: 'Read the full current HEAD SHA (fixed `git rev-parse HEAD`)',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args) => {
        const gitTools = capability.getGitTools();
        if (!gitTools) return { success: false, error: 'git not available' };
        const sha = await gitTools.headSha();
        return sha ? { success: true, result: sha } : { success: false, error: 'git HEAD unavailable' };
      },
    });

    // Регистрирует проект.test
    this.toolDefinitions.set('project.test', {
      name: 'project.test',
      description: 'Run project tests',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (args) => {
        if (Object.keys(args).length !== 0) {
          return { success: false, error: 'invalid project.test arguments' };
        }
        const result = await capability.getActionGateway().test();
          return {
            success: result.success,
            result,
            ...(!result.success ? { error: result.stderr || `project test exited with code ${String(result.exitCode)}` } : {}),
          };
      },
    });

    const projectTools = [
      ['project.lint', 'lint'],
      ['project.typecheck', 'typecheck'],
      ['project.build', 'build'],
    ] as const;
    for (const [toolId, action] of projectTools) {
      this.toolDefinitions.set(toolId, {
        name: toolId,
        description: `Run project ${action}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: async (args) => {
          if (Object.keys(args).length !== 0) return { success: false, error: `invalid ${toolId} arguments` };
          const result = await capability.getActionGateway()[action]();
          return { success: result.success, result, ...(result.success ? {} : { error: result.stderr }) };
        },
      });
    }

    const commandPolicies = capability.getActionGateway().getCommandPolicies();
    if (commandPolicies.length > 0) {
      this.toolDefinitions.set('command.exec', {
        name: 'command.exec',
        description: 'Run a declared command policy with validated arguments',
        inputSchema: {
          type: 'object',
          properties: {
            policyId: { type: 'string', enum: commandPolicies.map((policy) => policy.id) },
            args: { type: 'array', items: { type: 'string' } },
          },
          required: ['policyId', 'args'],
          additionalProperties: false,
        },
        handler: async (args) => {
          const result = await capability.getActionGateway().exec({
            policyId: args.policyId as string,
            args: args.args as unknown[],
          });
          return { success: result.success, result, ...(result.success ? {} : { error: result.stderr }) };
        },
      });
    }

    // Регистрирует submit_result.
    const submitTool = new SubmitResultTool(capability, completion);
    const roleOutputSchema = getRoleOutputJsonSchema(capability.capability.role);
    this.toolDefinitions.set('submit_result' as ToolId, {
      name: 'submit_result',
      description: 'Submit a result matching this run role contract and finalize the run',
      inputSchema: {
        type: 'object',
        properties: { payload: (roleOutputSchema as unknown as SchemaDefinition | undefined) ?? { type: 'object' } },
        required: ['payload'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const result = await submitTool.validateAndSubmit(args.payload);
        return result;
      },
    });
  }

  /**
   * Получает all tools available for this capability.
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
   * Получает a tool by name.
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
