import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { BackupService } from '../../../src/platform/database/backup-service.js';
import type { Database } from '../../../src/platform/database/database.js';

describe('backup service', () => {
  const databases: Database[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('creates an integrity-checkable backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-backup-'));
    directories.push(dir);
    const db = createSqliteDatabase(join(dir, 'source.db'));
    databases.push(db);
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
    const backup = new BackupService(db).createBackup(dir);
    expect(backup.path).toContain('orchestrator-');
    expect(new BackupService(db).integrityCheck()).toEqual({ ok: true, foreignKeys: true });
  });

  it('captures committed WAL data when the live database path is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orchestrator-backup-wal-'));
    directories.push(dir);
    const sourcePath = join(dir, 'source.db');
    const db = createSqliteDatabase(sourcePath);
    databases.push(db);
    db.exec('PRAGMA wal_autocheckpoint=0');
    db.exec('CREATE TABLE wal_sample (id INTEGER PRIMARY KEY, value TEXT)');
    db.run('INSERT INTO wal_sample (value) VALUES ($value)', { value: 'committed in WAL' });

    const backup = new BackupService(db).createBackup(dir);
    const restored = createSqliteDatabase(backup.path);
    databases.push(restored);
    expect(restored.get<{ value: string }>('SELECT value FROM wal_sample WHERE id = 1')).toEqual({ value: 'committed in WAL' });
  });
});
