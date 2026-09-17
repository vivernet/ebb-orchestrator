import type { GitHosting } from './git-hosting.js';
import { GitHubSyncService } from './github-sync-service.js';

export interface GitHubSyncWorkerOptions { intervalMs?: number; onFeedback?: (feedback: { issueId: number; title: string; body?: string | undefined }) => Promise<void>; }
/** Polling-only v1 worker. GitHub availability never blocks local work. */
export class GitHubSyncWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly hosting: GitHosting, private readonly sync: GitHubSyncService, private readonly options: GitHubSyncWorkerOptions = {}) {}
  async syncIssues(repository: string): Promise<'SYNCED' | 'SYNC_PENDING'> {
    const result = await this.hosting.importIssues(repository);
    if (result.status !== 'OK' || !result.value) return 'SYNC_PENDING';
    for (const issue of result.value) if (this.options.onFeedback) await this.options.onFeedback({ issueId: issue.id, title: issue.title, body: issue.body });
    return 'SYNCED';
  }
  start(repository: string): void { this.stop(); const interval = this.options.intervalMs ?? 60_000; this.timer = setInterval(() => { void this.syncIssues(repository); }, interval); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
