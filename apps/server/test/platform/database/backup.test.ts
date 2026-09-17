import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { BackupService } from '../../../src/platform/database/backup-service.js';

describe('backup service', () => {
  it('creates an integrity-checkable backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-backup-'));
    const db = createSqliteDatabase(join(dir, 'source.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
    const backup = new BackupService(db).createBackup(dir);
    expect(backup.path).toContain('orchestrator-');
    expect(new BackupService(db).integrityCheck()).toEqual({ ok: true, foreignKeys: true });
  });
});
