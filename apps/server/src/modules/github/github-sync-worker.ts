import type { Database } from '../../platform/database/database.js';
import type { GitHosting } from './git-hosting.js';
import { GitHubSyncService } from './github-sync-service.js';

export interface GitHubSyncWorkerOptions {
  intervalMs?: number;
  onFeedback?: (feedback: { repository: string; commentId: number; issueNumber: number; body: string; idempotencyKey: string }) => Promise<void>;
  persistFeedback?: (feedback: { repository: string; commentId: number; issueNumber: number; body: string; authorLogin: string; authorType: string; sourceUrl: string; sourceCreatedAt: string | null; sourceUpdatedAt: string | null }) => Promise<'DELIVERED' | 'UNMAPPED'>;
}

export type FeedbackDeliveryStatus = 'PENDING' | 'DELIVERED';

/** Хранит durable receipt HumanFeedback комментариев GitHub Issue. */
export class SqliteFeedbackDeliveryState {
  constructor(private readonly database: Database) {}

  /** Возвращает delivery state для уникального comment ID внутри репозитория. */
  getStatus(repository: string, commentId: number): FeedbackDeliveryStatus | undefined {
    const row = this.database.get<{ status: string }>(
      'SELECT status FROM github_feedback_deliveries WHERE repository = $repository AND comment_id = $commentId',
      { repository, commentId },
    );
    if (!row) return undefined;
    if (row.status !== 'PENDING' && row.status !== 'DELIVERED') throw new Error('GitHub feedback receipt has an unsupported status');
    return row.status;
  }

  /** Записывает durable pending receipt до callback, чтобы restart мог повторить доставку. */
  markPending(repository: string, commentId: number, issueNumber: number): void {
    this.database.run(
      `INSERT INTO github_feedback_deliveries (repository, comment_id, issue_number, status, created_at, delivered_at)
       VALUES ($repository, $commentId, $issueNumber, 'PENDING', $now, NULL)
       ON CONFLICT(repository, comment_id) DO NOTHING`,
      { repository, commentId, issueNumber, now: new Date().toISOString() },
    );
  }

  /** Отмечает callback delivery после успешного durable HumanFeedback handoff. */
  markDelivered(repository: string, commentId: number): void {
    this.database.run(
      `UPDATE github_feedback_deliveries SET status = 'DELIVERED', delivered_at = $now
       WHERE repository = $repository AND comment_id = $commentId AND status = 'PENDING'`,
      { repository, commentId, now: new Date().toISOString() },
    );
  }
}

/** Worker v1 импортирует только human comments к Issues; GitHub availability не блокирует локальный workflow. */
export class GitHubSyncWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly activeRepositories = new Set<string>();
  constructor(
    private readonly hosting: GitHosting,
    private readonly sync: GitHubSyncService,
    private readonly feedbackState: SqliteFeedbackDeliveryState,
    private readonly options: GitHubSyncWorkerOptions = {},
  ) {}

  /** Импортирует human Issue comments с устойчивым ключом для at-least-once callback delivery. */
  async syncIssues(repository: string): Promise<'SYNCED' | 'SYNC_PENDING'> {
    if (this.activeRepositories.has(repository)) return 'SYNC_PENDING';
    this.activeRepositories.add(repository);
    try {
      const result = await this.hosting.listIssueComments(repository);
      if (result.status !== 'OK' || !result.value) return 'SYNC_PENDING';
      const comments = result.value.filter((comment) => comment.authorType.toLowerCase() !== 'bot' && !comment.body.includes('ORCHESTRATOR:'));
      if (comments.length > 0 && !this.options.onFeedback && !this.options.persistFeedback) return 'SYNC_PENDING';
      for (const comment of comments) {
        const status = this.feedbackState.getStatus(repository, comment.id);
        if (status === 'DELIVERED') continue;
        if (this.options.persistFeedback) {
          try {
            const persisted = await this.options.persistFeedback({
              repository,
              commentId: comment.id,
              issueNumber: comment.issueNumber,
              body: comment.body,
              authorLogin: comment.authorLogin ?? 'unknown',
              authorType: comment.authorType,
              sourceUrl: comment.sourceUrl ?? `https://github.com/${repository}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
              sourceCreatedAt: comment.sourceCreatedAt ?? null,
              sourceUpdatedAt: comment.sourceUpdatedAt ?? null,
            });
            if (persisted === 'UNMAPPED') return 'SYNC_PENDING';
          } catch { return 'SYNC_PENDING'; }
          continue;
        }
        const idempotencyKey = `github:${repository}:issue-comment:${comment.id}`;
        try {
          this.feedbackState.markPending(repository, comment.id, comment.issueNumber);
          await this.options.onFeedback!({
            repository,
            commentId: comment.id,
            issueNumber: comment.issueNumber,
            body: comment.body,
            idempotencyKey,
          });
          this.feedbackState.markDelivered(repository, comment.id);
        } catch {
          return 'SYNC_PENDING';
        }
      }
      return 'SYNCED';
    } finally {
      this.activeRepositories.delete(repository);
    }
  }
  start(repository: string): void { this.stop(); const interval = this.options.intervalMs ?? 60_000; this.timer = setInterval(() => { void this.syncIssues(repository).catch(() => undefined); }, interval); }
  startMappedRepositories(listRepositories: () => string[]): void {
    this.stop();
    const interval = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void (async () => { for (const repository of listRepositories()) await this.syncIssues(repository); })().catch(() => undefined);
    }, interval);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
