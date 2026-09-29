import type { GitHosting, PullRequest } from './git-hosting.js';
import type { Database } from '../../platform/database/database.js';

export interface SyncRecord { key: string; repository: string; marker: string; pullRequest?: PullRequest; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; updatedAt: number; }
export interface SyncState { get(key: string): SyncRecord | undefined; set(record: SyncRecord): void; }

/** Сохраняет состояние PR-sync в памяти; предназначен для изолированных тестов. */
export class InMemorySyncState implements SyncState {
  private readonly records = new Map<string, SyncRecord>();

  get(key: string): SyncRecord | undefined {
    return this.records.get(key);
  }

  set(record: SyncRecord): void {
    this.records.set(record.key, record);
  }
}

interface SqliteSyncRecordRow {
  key: string;
  repository: string;
  marker: string;
  status: string;
  updated_at: string;
}

/**
 * Хранит состояние GitHub PR sync в мигрированной таблице `github_sync_records`.
 * Сохраняет только sync metadata; GitHub credentials и необработанные ответы API сюда не попадают.
 */
export class SqliteSyncState implements SyncState {
  constructor(private readonly database: Database) {}

  /** Возвращает сохранённое состояние; PR после process restart повторно сверяется с GitHub по marker. */
  get(key: string): SyncRecord | undefined {
    const row = this.database.get<SqliteSyncRecordRow>(
      `SELECT key, repository, marker, status, updated_at FROM github_sync_records WHERE key = $key`,
      { key },
    );
    if (!row) return undefined;
    if (row.status !== 'PENDING' && row.status !== 'SUCCEEDED' && row.status !== 'FAILED') {
      throw new Error('GitHub sync record has an unsupported status');
    }
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt)) throw new Error('GitHub sync record has an invalid timestamp');
    return { key: row.key, repository: row.repository, marker: row.marker, status: row.status, updatedAt };
  }

  /** Атомарно upsert-ит sync metadata для последующего reconciliation после restart. */
  set(record: SyncRecord): void {
    if (!Number.isFinite(record.updatedAt)) throw new Error('GitHub sync record has an invalid timestamp');
    this.database.run(
      `INSERT INTO github_sync_records (key, repository, marker, remote_id, remote_url, status, updated_at)
       VALUES ($key, $repository, $marker, $remote_id, $remote_url, $status, $updated_at)
       ON CONFLICT(key) DO UPDATE SET
         repository = excluded.repository,
         marker = excluded.marker,
         remote_id = excluded.remote_id,
         remote_url = excluded.remote_url,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      {
        key: record.key,
        repository: record.repository,
        marker: record.marker,
        remote_id: record.pullRequest?.id ?? null,
        remote_url: record.pullRequest?.url ?? null,
        status: record.status,
        updated_at: new Date(record.updatedAt).toISOString(),
      },
    );
  }
}

/** Координирует идемпотентные исходящие GitHub operations и pending state при недоступности сети. */
export class GitHubSyncService {
  /**
   * Создаёт координатор PR sync с явно выбранным состоянием.
   * Для production передаётся SQLite adapter; неявная память могла бы потерять подтверждённую синхронизацию при restart.
   */
  constructor(private readonly hosting: GitHosting, private readonly state: SyncState) {}

  /**
   * Находит PR по стабильному маркеру до создания и сохраняет результат операции.
   * Внешняя ошибка или недоступность оставляет запись `PENDING`; ошибка state storage пробрасывается вызывающему коду,
   * чтобы следующий вызов повторно сверил удалённое состояние и не создавал дубликат.
   */
  async ensurePullRequest(repository: string, key: string, input: { head: string; base: string; title: string; body?: string }): Promise<SyncRecord> {
    const marker = `ORCHESTRATOR:${key}`;
    const existing = this.state.get(key);
    if (existing?.status === 'SUCCEEDED' && existing.pullRequest) return existing;
    const remote = await this.hosting.findPullRequest(repository, marker);
    if (remote.status === 'OK' && remote.value) {
      const record = { key, repository, marker, pullRequest: remote.value, status: 'SUCCEEDED' as const, updatedAt: Date.now() };
      this.state.set(record); return record;
    }
    if (remote.status !== 'OK') {
      const record = { key, repository, marker, status: 'PENDING' as const, updatedAt: Date.now() };
      this.state.set(record); return record;
    }
    const created = await this.hosting.createPullRequest(repository, { ...input, body: `${input.body ?? ''}\n\n${marker}` });
    const record = created.status === 'OK' && created.value
      ? { key, repository, marker, pullRequest: created.value, status: 'SUCCEEDED' as const, updatedAt: Date.now() }
      : { key, repository, marker, status: 'PENDING' as const, updatedAt: Date.now() };
    this.state.set(record); return record;
  }

  /** Возвращает подключённый state adapter для статуса синхронизации и reconciliation. */
  getState(): SyncState { return this.state; }
}
