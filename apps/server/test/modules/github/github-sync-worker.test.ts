import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import type { Database } from '../../../src/platform/database/database.js';
import { loadTestMigrations } from '../../helpers/migrations.js';
import { GitHubSyncService, InMemorySyncState } from '../../../src/modules/github/github-sync-service.js';
import { GitHubSyncWorker, SqliteFeedbackDeliveryState } from '../../../src/modules/github/github-sync-worker.js';
import type { GitHosting } from '../../../src/modules/github/git-hosting.js';

describe('GitHub sync idempotency', () => {
  let tempDirectory: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('discovers an existing PR after a crash instead of creating a duplicate', async () => {
    const hosting = {
      findPullRequest: vi.fn().mockResolvedValue({ status: 'OK', value: { id: 1, number: 7, url: 'u', state: 'open', head: 'h', base: 'main' } }),
      createPullRequest: vi.fn(),
    };
    const service = new GitHubSyncService(hosting as unknown as GitHosting, new InMemorySyncState());
    const result = await service.ensurePullRequest('o/r', 'task-1', { head: 'h', base: 'main', title: 'T' });
    expect(result.status).toBe('SUCCEEDED');
    expect(hosting.createPullRequest).not.toHaveBeenCalled();
  });

  it('delivers human Issue comments once and persists comment-ID deduplication', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orchestrator-github-feedback-'));
    const databasePath = join(tempDirectory, 'orchestrator.db');
    db = createSqliteDatabase(databasePath);
    const { runMigrations } = await import('../../../src/platform/database/migrator.js');
    runMigrations(db, loadTestMigrations());
    const comments = [
      { id: 101, issueNumber: 5, body: 'Please retain this behavior.', authorType: 'User' },
      { id: 102, issueNumber: 5, body: 'ORCHESTRATOR:task-1 synced', authorType: 'Bot' },
      { id: 103, issueNumber: 5, body: 'ORCHESTRATOR:task-2 synced', authorType: 'User' },
      { id: 104, issueNumber: 5, body: 'ORCHESTRATOR:', authorType: 'User' },
    ];
    const hosting = { listIssueComments: vi.fn(async () => ({ status: 'OK' as const, value: comments })) };
    const onFeedback = vi.fn(async () => {});
    const sync = new GitHubSyncService(hosting as unknown as GitHosting, new InMemorySyncState());
    const worker = new GitHubSyncWorker(hosting as unknown as GitHosting, sync, new SqliteFeedbackDeliveryState(db), { onFeedback });

    expect(await worker.syncIssues('o/r')).toBe('SYNCED');
    expect(onFeedback).toHaveBeenCalledOnce();
    expect(onFeedback).toHaveBeenCalledWith({
      repository: 'o/r', commentId: 101, issueNumber: 5,
      body: 'Please retain this behavior.', idempotencyKey: 'github:o/r:issue-comment:101',
    });
    expect(await worker.syncIssues('o/r')).toBe('SYNCED');
    expect(onFeedback).toHaveBeenCalledOnce();

    db.close();
    db = createSqliteDatabase(databasePath);
    runMigrations(db, loadTestMigrations());
    const restarted = new GitHubSyncWorker(hosting as unknown as GitHosting, sync, new SqliteFeedbackDeliveryState(db), { onFeedback });
    expect(await restarted.syncIssues('o/r')).toBe('SYNCED');
    expect(onFeedback).toHaveBeenCalledOnce();
  });

  it('retries a pending comment with a stable idempotency key after callback failure', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orchestrator-github-feedback-retry-'));
    db = createSqliteDatabase(join(tempDirectory, 'orchestrator.db'));
    const { runMigrations } = await import('../../../src/platform/database/migrator.js');
    runMigrations(db, loadTestMigrations());
    const hosting = {
      listIssueComments: vi.fn(async () => ({
        status: 'OK' as const,
        value: [{ id: 201, issueNumber: 9, body: 'Please review this requirement.', authorType: 'User' }],
      })),
    };
    const onFeedback = vi.fn().mockRejectedValueOnce(new Error('consumer temporarily unavailable')).mockResolvedValue(undefined);
    const sync = new GitHubSyncService(hosting as unknown as GitHosting, new InMemorySyncState());
    const worker = new GitHubSyncWorker(hosting as unknown as GitHosting, sync, new SqliteFeedbackDeliveryState(db), { onFeedback });

    expect(await worker.syncIssues('o/r')).toBe('SYNC_PENDING');
    expect(await worker.syncIssues('o/r')).toBe('SYNCED');
    expect(onFeedback).toHaveBeenCalledTimes(2);
    expect(onFeedback.mock.calls[0]?.[0].idempotencyKey).toBe('github:o/r:issue-comment:201');
    expect(onFeedback.mock.calls[1]?.[0].idempotencyKey).toBe('github:o/r:issue-comment:201');
  });

  it('serializes manual and polling syncs for the same repository', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orchestrator-github-feedback-concurrent-'));
    db = createSqliteDatabase(join(tempDirectory, 'orchestrator.db'));
    const { runMigrations } = await import('../../../src/platform/database/migrator.js');
    runMigrations(db, loadTestMigrations());
    const hosting = {
      listIssueComments: vi.fn(async () => ({
        status: 'OK' as const,
        value: [{ id: 301, issueNumber: 12, body: 'New requirement.', authorType: 'User' }],
      })),
    };
    let releaseDelivery!: () => void;
    const onFeedback = vi.fn(() => new Promise<void>((resolve) => { releaseDelivery = resolve; }));
    const sync = new GitHubSyncService(hosting as unknown as GitHosting, new InMemorySyncState());
    const worker = new GitHubSyncWorker(hosting as unknown as GitHosting, sync, new SqliteFeedbackDeliveryState(db), { onFeedback });

    const firstSync = worker.syncIssues('o/r');
    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledOnce());
    expect(await worker.syncIssues('o/r')).toBe('SYNC_PENDING');
    releaseDelivery();
    expect(await firstSync).toBe('SYNCED');
    expect(onFeedback).toHaveBeenCalledOnce();
  });
});
