/**
 * Database schema migrations for agent_runs table.
 */

export const schema = `CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
  task_id TEXT, epic_id TEXT, status TEXT NOT NULL, prompt TEXT, started_at TEXT, ended_at TEXT,
  exit_code INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost REAL, output TEXT
)`;

export const migrationColumns = [
  "capability_ref TEXT", "capability_json TEXT", "session_id TEXT", "attempt INTEGER",
  "trigger_reason TEXT", "context_version TEXT", "output_schema_version TEXT", "prompt TEXT",
  "cached_input_tokens INTEGER", "output TEXT",
];

/**
 * Generates SQL migration statements for adding columns to agent_runs table.
 * @param columns Array of column definitions (e.g. "capability_ref TEXT")
 * @returns Array of ALTER TABLE statements
 */
export function getMigrationSQL(columns: string[]): string[] {
  return columns.map(column => {
    return `ALTER TABLE agent_runs ADD COLUMN ${column}`;
  });
}
