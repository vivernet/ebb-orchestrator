import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.js';

export interface BackupResult { path: string; createdAt: string; }
/** Creates a point-in-time SQLite backup before migrations. */
export class BackupService {
  constructor(private readonly db: Database, private readonly databasePath?: string) {}
  createBackup(destinationDir: string): BackupResult {
    mkdirSync(destinationDir, { recursive: true });
    const path = join(destinationDir, `orchestrator-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    if (this.databasePath && existsSync(this.databasePath)) copyFileSync(this.databasePath, path);
    else this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    return { path, createdAt: new Date().toISOString() };
  }
  integrityCheck(): { ok: boolean; foreignKeys: boolean } {
    const integrity = this.db.get<{ integrity_check: string; result?: string }>('PRAGMA integrity_check');
    const foreignKeys = this.db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    return { ok: integrity?.integrity_check === 'ok' || integrity?.result === 'ok', foreignKeys: foreignKeys?.foreign_keys === 1 };
  }
}
