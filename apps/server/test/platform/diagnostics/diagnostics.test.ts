import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { DiagnosticsService } from '../../../src/platform/diagnostics/diagnostics-service.js';
import { SecretRedactor } from '../../../src/platform/security/secret-redactor.js';

describe('diagnostics export', () => {
  it('redacts exact secret values and returns operational counters', () => {
    const db = createSqliteDatabase(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER, name TEXT, applied_at TEXT); CREATE TABLE jobs (id TEXT); CREATE TABLE outbox (status TEXT); CREATE TABLE scheduler_resource_locks (resource_key TEXT);');
    const redactor = new SecretRedactor();
    redactor.addSecret('test', 'plaintext-secret');
    const snapshot = new DiagnosticsService(db, { appVersion: 'test', schemaVersion: 1, redactor, recentErrors: ['plaintext-secret'] }).snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('plaintext-secret');
    expect(snapshot.pendingOutbox).toBe(0);
  });
});
