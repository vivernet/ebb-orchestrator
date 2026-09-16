/**
 * Orchestrator MCP stdio server CLI entry point.
 * 
 * Usage: orchestrator-mcp --capability-ref <orchestrator-issued-reference>
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
  const databasePath = args.database ?? process.env.ORCHESTRATOR_DATABASE;
  if (!databasePath) throw new Error('orchestrator database is required');
  const db = createSqliteDatabase(databasePath);
  const capability = loadValidatedCapability(db, capabilityRef);

  // Create MCP server
  const server = new McpServer(capability, { completion: new DatabaseCompletionStore(db) });

  // Process stdio requests
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    try {
      const request = JSON.parse(line.toString());
      const response = await server.processRequest(request);
      const toolResult = response.result as { success?: boolean; result?: unknown };
      if (request.method === 'tools/call' && request.params?.name === 'submit_result' && toolResult.success && resultFile) {
        await mkdir(dirname(resultFile), { recursive: true });
        await writeFile(resultFile, JSON.stringify(toolResult.result), { encoding: 'utf8', flag: 'wx' });
      }
      // Hermes speaks JSON-RPC over stdio. Keep the domain response above
      // simple, but always emit an id-bearing protocol response here.
      let result: unknown = response.result;
      if (request.method === 'tools/list') result = { tools: response.result };
      if (request.method === 'tools/call') {
        const call = response.result as { success?: boolean; result?: unknown; error?: string };
        result = {
          content: [{ type: 'text', text: JSON.stringify(call.success ? call.result : { error: call.error }) }],
          isError: call.success !== true,
        };
      }
      // The local diagnostic handshake historically omits ids; answer those
      // requests as well. Real JSON-RPC notifications remain silent.
      if (request.id !== undefined || request.method === 'initialize' || request.method === 'tools/list') {
        console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result }));
      }
    } catch (err) {
      console.error(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown error' }));
    }
  }
  db.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
