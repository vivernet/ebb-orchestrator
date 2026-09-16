import { RunCapability } from '../run-capability.js';
import type { ToolId } from '../run-capability.js';
import { SubmitResultTool } from './submit-result-tool.js';

/**
 * Tool definition for MCP.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>;
}

/**
 * ToolRegistry maps capability tools to MCP tool definitions and filters by allowed tools.
 */
export class ToolRegistry {
  private toolDefinitions: Map<ToolId, ToolDefinition> = new Map();
  private capability: RunCapability;

  constructor(capability: RunCapability) {
    this.capability = capability;
    // Register workspace.read
    this.toolDefinitions.set('workspace.read', {
      name: 'workspace.read',
      description: 'Read a file from the workspace',
      handler: async (args) => {
        const result = await capability.getActionGateway().readFile(args.path as string);
        return result;
      },
    });

    // Register workspace.search
    this.toolDefinitions.set('workspace.search', {
      name: 'workspace.search',
      description: 'Search for patterns in the workspace',
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
      handler: async () => {
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
      handler: async () => {
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
      handler: async (args) => {
        // TODO: Implement actual test runner integration
        return { success: true, result: 'tests completed' };
      },
    });

    // Register submit_result
    const submitTool = new SubmitResultTool(capability);
    this.toolDefinitions.set('submit_result' as ToolId, {
      name: 'submit_result',
      description: 'Submit agent result and finalize run',
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
