/**
 * Orchestrator MCP stdio server CLI entry point.
 * 
 * Usage: ebb-orchestrator-mcp --capability-ref <orchestrator-issued-reference>
 * 
 * The capability ID determines the role and tool access for this MCP server instance.
 */
import { McpServer } from '../modules/execution/mcp/mcp-server.js';
import { loadValidatedCapability } from '../modules/execution/capability-validation.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSqliteDatabase } from '../platform/database/sqlite-database.js';
import { DatabaseCompletionStore } from '../modules/execution/mcp/submit-result-tool.js';
import { createInterface } from 'node:readline';

function parseArgs(): { capabilityRef: string | undefined; resultFile: string | undefined; database: string | undefined } {
  const args = process.argv.slice(2);
  const result: { capabilityRef: string | undefined; resultFile: string | undefined; database: string | undefined } = {
    capabilityRef: undefined,
    resultFile: undefined, database: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--capability-ref' && i + 1 < args.length) {
      result.capabilityRef = args[++i];
    } else if (args[i] === '--result-file' && i + 1 < args.length) {
      result.resultFile = args[++i];
    } else if (args[i] === '--database' && i + 1 < args.length) {
      result.database = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: ebb-orchestrator-mcp --capability-ref <orchestrator-issued-reference>');
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
  const databasePath = args.database ?? process.env.ORCHESTRATOR_DATABASE;
  if (!databasePath) throw new Error('orchestrator database is required');
  const db = createSqliteDatabase(databasePath);
  const capability = loadValidatedCapability(db, capabilityRef);

  // Create MCP server
  const server = new McpServer(capability, { completion: new DatabaseCompletionStore(db) });

  // Process stdio requests
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    let request: unknown;
    try {
      request = JSON.parse(line.toString());
    } catch {
      console.log(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      continue;
    }
    try {
      const response = await server.processRequest(request);
      const requestRecord = request && typeof request === 'object' && !Array.isArray(request)
        ? request as Record<string, unknown> : undefined;
      const requestParams = requestRecord?.params && typeof requestRecord.params === 'object' && !Array.isArray(requestRecord.params)
        ? requestRecord.params as Record<string, unknown> : undefined;
      if (requestRecord?.method === 'tools/call' && requestParams?.name === 'submit_result' && response && resultFile) {
        const content = (response.result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
        const toolResult = content ? JSON.parse(content) as { outcome?: unknown } : undefined;
        if (toolResult?.outcome === undefined) throw new Error('submit_result did not return a result');
        await mkdir(dirname(resultFile), { recursive: true });
        await writeFile(resultFile, JSON.stringify(toolResult), { encoding: 'utf8', flag: 'wx' });
      }
      if (response) console.log(JSON.stringify(response));
    } catch {
      const id = request && typeof request === 'object' && !Array.isArray(request) &&
        ('id' in request) && (typeof request.id === 'string' || typeof request.id === 'number' || request.id === null)
        ? request.id : undefined;
      if (id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } }));
    }
  }
  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
