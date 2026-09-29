import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.js';

export interface BackupResult { path: string; createdAt: string; }
/** Создаёт моментальный backup SQLite перед применением миграций. */
export class BackupService {
  constructor(private readonly db: Database) {}
  createBackup(destinationDir: string): BackupResult {
    mkdirSync(destinationDir, { recursive: true });
    const path = join(destinationDir, `orchestrator-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { path, createdAt: new Date().toISOString() };
  }
  integrityCheck(): { ok: boolean; foreignKeys: boolean } {
    const integrity = this.db.get<{ integrity_check: string; result?: string }>('PRAGMA integrity_check');
    const foreignKeys = this.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    return { ok: integrity?.integrity_check === 'ok' || integrity?.result === 'ok', foreignKeys: foreignKeys?.foreign_keys === 1 };
  }
}
