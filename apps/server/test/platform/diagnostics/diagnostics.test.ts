import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { DiagnosticsService } from '../../../src/platform/diagnostics/diagnostics-service.js';
import { SecretRedactor } from '../../../src/platform/security/secret-redactor.js';

describe('diagnostics export', () => {
  it('redacts exact secret values and returns operational counters', () => {
    const db = createSqliteDatabase(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER, name TEXT, applied_at TEXT); CREATE TABLE background_jobs (id TEXT, type TEXT, status TEXT, attempts INTEGER, max_attempts INTEGER, lease_owner TEXT, lease_expires_at TEXT, last_error TEXT, updated_at TEXT); CREATE TABLE outbox_events (id TEXT, processed_at TEXT, dead_lettered_at TEXT); CREATE TABLE scheduler_resource_locks (resource_key TEXT);');
    db.run("INSERT INTO background_jobs VALUES ('job-1','test','RUNNING',1,5,NULL,NULL,NULL,'2026-01-01T00:00:00.000Z')");
    db.run("INSERT INTO outbox_events VALUES ('event-1',NULL,NULL)");
    db.run("INSERT INTO outbox_events VALUES ('event-2',NULL,'2026-01-01T00:00:00.000Z')");
    const redactor = new SecretRedactor();
    redactor.addSecret('test', 'plaintext-secret');
    const snapshot = new DiagnosticsService(db, { appVersion: 'test', schemaVersion: 1, redactor, recentErrors: ['plaintext-secret'] }).snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('plaintext-secret');
    expect(snapshot.pendingOutbox).toBe(1);
    expect(snapshot.deadLetter).toBe(1);
    expect(snapshot.workerHealth).toHaveLength(1);
  });
});
