/**
 * Orchestrator MCP stdio server CLI entry point.
 * 
 * Usage: orchestrator-mcp --capability <capability-id> [--workspace <path>]
 * 
 * The capability ID determines the role and tool access for this MCP server instance.
 */
import { McpServer } from '../modules/execution/mcp/mcp-server.js';
import { RunCapability } from '../modules/execution/run-capability.js';

function parseArgs(): { capability: string | undefined; workspace: string | undefined } {
  const args = process.argv.slice(2);
  const result: { capability: string | undefined; workspace: string | undefined } = {
    capability: undefined,
    workspace: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--capability' && i + 1 < args.length) {
      result.capability = args[++i];
    } else if (args[i] === '--workspace' && i + 1 < args.length) {
      result.workspace = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: orchestrator-mcp --capability <capability-id> [--workspace <path>]');
      process.exit(0);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  // Get capability from environment or args
  const capabilityId = args.capability || process.env.CAPABILITY_ID;
  const workspace = args.workspace || process.env.WORKSPACE_PATH;

  if (!capabilityId) {
    console.error('Error: capability ID required via --capability or CAPABILITY_ID env var');
    process.exit(1);
  }

  // Map capability ID to role (simplified - in real implementation would look up from config)
  const roleMap: Record<string, 'developer' | 'reviewer' | 'qa' | 'integration'> = {
    'reviewer': 'reviewer',
    'developer': 'developer',
    'qa': 'qa',
    'integration': 'integration',
  };

  const role = roleMap[capabilityId] || 'developer';

  // Define allowed tools based on role
  let allowedTools: ('workspace.read' | 'workspace.search' | 'workspace.patch' | 'git.diff' | 'git.commit' | 'project.test' | 'submit_result')[];
  switch (role) {
    case 'reviewer':
      allowedTools = ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'];
      break;
    case 'developer':
      allowedTools = ['workspace.read', 'workspace.search', 'workspace.patch', 'git.diff', 'git.commit', 'project.test', 'submit_result'];
      break;
    case 'qa':
      allowedTools = ['workspace.read', 'workspace.search', 'git.diff', 'project.test', 'submit_result'];
      break;
    default:
      allowedTools = ['workspace.read', 'workspace.search', 'submit_result'];
  }

  if (!workspace) {
    console.error('Error: workspace path required via --workspace or WORKSPACE_PATH env var');
    process.exit(1);
  }

  // Create capability
  const capability = new RunCapability({
    id: capabilityId,
    role: role as 'developer' | 'reviewer' | 'qa' | 'integration',
    workspace: workspace,
    allowedTools: allowedTools,
  });

  // Create MCP server
  const server = new McpServer(capability);

  // Process stdio requests
  for await (const line of process.stdin) {
    try {
      const request = JSON.parse(line.toString());
      const response = await server.processRequest(request);
      console.log(JSON.stringify(response));
    } catch (err) {
      console.error(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown error' }));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
