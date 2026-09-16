/**
 * Orchestrator MCP stdio server CLI entry point.
 * 
 * Usage: orchestrator-mcp --capability-ref <orchestrator-issued-reference>
 * 
 * The capability ID determines the role and tool access for this MCP server instance.
 */
import { McpServer } from '../modules/execution/mcp/mcp-server.js';
import { RunCapability } from '../modules/execution/run-capability.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function parseArgs(): { capabilityRef: string | undefined; resultFile: string | undefined } {
  const args = process.argv.slice(2);
  const result: { capabilityRef: string | undefined; resultFile: string | undefined } = {
    capabilityRef: undefined,
    resultFile: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--capability-ref' && i + 1 < args.length) {
      result.capabilityRef = args[++i];
    } else if (args[i] === '--result-file' && i + 1 < args.length) {
      result.resultFile = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: orchestrator-mcp --capability-ref <orchestrator-issued-reference>');
      process.exit(0);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  // Get capability from environment or args
  const capabilityRef = args.capabilityRef || process.env.ORCHESTRATOR_CAPABILITY_REF;
  const resultFile = args.resultFile || process.env.ORCHESTRATOR_RESULT_FILE;

  if (!capabilityRef) {
    console.error('Error: orchestrator-issued capability reference required');
    process.exit(1);
  }
  const storePath = process.env.ORCHESTRATOR_CAPABILITY_STORE;
  if (!storePath) throw new Error('orchestrator capability store is required');
  const store = JSON.parse(await readFile(storePath, 'utf8')) as Record<string, { runId: string; role: 'developer' | 'reviewer' | 'qa' | 'integration'; workspace: string; allowedTools: Array<'workspace.read' | 'workspace.search' | 'workspace.patch' | 'git.diff' | 'git.commit' | 'project.test' | 'submit_result'> }>;
  const issued = store[capabilityRef];
  if (!issued) throw new Error('unknown or expired capability reference');

  const capability = new RunCapability({ id: capabilityRef, capabilityRef, runId: issued.runId, role: issued.role, workspace: issued.workspace, allowedTools: issued.allowedTools });

  // Create MCP server
  const server = new McpServer(capability);

  // Process stdio requests
  for await (const line of process.stdin) {
    try {
      const request = JSON.parse(line.toString());
      const response = await server.processRequest(request);
      const toolResult = response.result as { success?: boolean; result?: unknown };
      if (request.method === 'tools/call' && request.params?.name === 'submit_result' && toolResult.success && resultFile) {
        await mkdir(dirname(resultFile), { recursive: true });
        await writeFile(resultFile, JSON.stringify(toolResult.result), { encoding: 'utf8', flag: 'wx' });
      }
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
