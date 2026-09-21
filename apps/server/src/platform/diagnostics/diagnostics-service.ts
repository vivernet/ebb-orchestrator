import type { Database } from '../database/database.js';
import { SecretRedactor } from '../security/secret-redactor.js';

export interface DiagnosticsOptions { appVersion: string; schemaVersion: number; redactor?: SecretRedactor; recentErrors?: string[]; }
export interface DiagnosticsSnapshot { appVersion: string; schemaVersion: number; migrationHistory: unknown[]; workerHealth: unknown[]; pendingOutbox: number; deadLetter: number; staleLocks: number; recentErrors: string[]; }

/** Формирует безопасный для JSON operational snapshot с точной redaction значений. */
export class DiagnosticsService {
  constructor(private readonly db: Database, private readonly options: DiagnosticsOptions) {}
  snapshot(): DiagnosticsSnapshot {
    const redact = (value: unknown) => this.options.redactor?.redact(JSON.stringify(value)) ?? JSON.stringify(value);
    const rows = <T>(sql: string): T[] => { try { return this.db.all<T>(sql); } catch { return []; } };
    const count = (sql: string) => { try { return Number(this.db.get<{ count: number }>(sql)?.count ?? 0); } catch { return 0; } };
    return {
      appVersion: this.options.appVersion,
      schemaVersion: this.options.schemaVersion,
      migrationHistory: rows('SELECT version, name, applied_at FROM schema_migrations ORDER BY version'),
      workerHealth: rows('SELECT id, type, status, attempts, max_attempts, lease_owner, lease_expires_at, last_error, updated_at FROM background_jobs ORDER BY updated_at DESC LIMIT 100'),
      pendingOutbox: count("SELECT COUNT(*) as count FROM outbox_events WHERE processed_at IS NULL AND dead_lettered_at IS NULL"),
      deadLetter: count("SELECT COUNT(*) as count FROM outbox_events WHERE dead_lettered_at IS NOT NULL"),
      staleLocks: count('SELECT COUNT(*) as count FROM scheduler_resource_locks'),
      recentErrors: (this.options.recentErrors ?? []).map((error) => JSON.parse(redact(error))),
    };
  }
}
