import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from './database.js';
import { hasPendingMigrations, runMigrations, type Migration } from './migrator.js';

export interface BackupResult { path: string; createdAt: string; }
/** Создаёт моментальный backup SQLite перед применением миграций. */
export class BackupService {
  constructor(private readonly db: Database) {}
  createBackup(destinationDir: string): BackupResult {
    mkdirSync(destinationDir, { recursive: true });
    const path = join(destinationDir, `ebb-orchestrator-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const verification = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = verification.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      const foreignKeyErrors = verification.prepare('PRAGMA foreign_key_check').all();
      if (integrity?.integrity_check !== 'ok' || foreignKeyErrors.length > 0) throw new Error('Database backup verification failed.');
    } finally { verification.close(); }
    return { path, createdAt: new Date().toISOString() };
  }
  integrityCheck(): { ok: boolean; foreignKeys: boolean } {
    const integrity = this.db.get<{ integrity_check: string; result?: string }>('PRAGMA integrity_check');
    const foreignKeys = this.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    return { ok: integrity?.integrity_check === 'ok' || integrity?.result === 'ok', foreignKeys: foreignKeys?.foreign_keys === 1 };
  }
}

/** Останавливает schema migration, если создание или проверка pre-migration backup не прошли. */
export function applyMigrationsWithVerifiedBackup(db: Database, migrations: Migration[], destinationDir: string): void {
  if (hasPendingMigrations(db, migrations)) new BackupService(db).createBackup(destinationDir);
  runMigrations(db, migrations);
}
