import type { GitHosting, PullRequest } from './git-hosting.js';

export interface SyncRecord { key: string; repository: string; marker: string; pullRequest?: PullRequest; status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; updatedAt: number; }
export interface SyncState { get(key: string): SyncRecord | undefined; set(record: SyncRecord): void; }
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class InMemorySyncState implements SyncState { private records = new Map<string, SyncRecord>(); get(key: string) { return this.records.get(key); } set(record: SyncRecord) { this.records.set(record.key, record); } }

/** Coordinates idempotent outbound GitHub operations and offline pending state. */
export class GitHubSyncService {
  constructor(private readonly hosting: GitHosting, private readonly state: SyncState = new InMemorySyncState()) {}
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
  getState(): SyncState { return this.state; }
}
