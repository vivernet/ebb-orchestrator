import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import type { Database } from "../../src/platform/database/database.js";

/** Создаёт минимальную fixture-схему для Git integration и merge tests. */
export function createIntegrationTestDatabase(path: string): Database {
  const database = createSqliteDatabase(path);
  database.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL,
      output TEXT, epic_id TEXT, capability_json TEXT, ended_at TEXT, exit_code INTEGER
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, subject_id TEXT NOT NULL,
      subject_type TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE epics (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, display_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE onboarding_configs (
      project_id TEXT NOT NULL, repository_path TEXT NOT NULL,
      facts_json TEXT NOT NULL, proposed_json TEXT NOT NULL,
      status TEXT NOT NULL, approval_id TEXT NOT NULL
    );
    CREATE TABLE epic_orchestrations (
      epic_id TEXT PRIMARY KEY, stage TEXT, final_approval_id TEXT
    );
    CREATE TABLE orchestration_phase_runs (
      agent_run_id TEXT PRIMARY KEY, epic_id TEXT, task_id TEXT, phase TEXT, validated INTEGER
    );
    CREATE TABLE git_operations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
      repo_path TEXT NOT NULL, branch_name TEXT, target_ref TEXT,
      created_at TEXT NOT NULL, verified_at TEXT, approval_id TEXT,
      source_sha TEXT, expected_target_sha TEXT, resulting_target_sha TEXT,
      failure_reason TEXT
    );
    CREATE TABLE integration_attempts (
      id TEXT PRIMARY KEY, repository_path TEXT NOT NULL,
      source_branch TEXT NOT NULL, target_branch TEXT NOT NULL,
      expected_target_sha TEXT NOT NULL, source_sha TEXT NOT NULL,
      worktree_path TEXT NOT NULL, integration_run_id TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER integration_attempts_immutable_provenance
    BEFORE UPDATE OF id, repository_path, source_branch, target_branch,
      expected_target_sha, worktree_path, integration_run_id, created_at, source_sha
    ON integration_attempts
    BEGIN
      SELECT RAISE(ABORT, 'integration provenance is immutable');
    END;
  `);
  return database;
}
