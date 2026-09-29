import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { runMigrations } from '../../../src/platform/database/migrator.js';
import { loadTestMigrations } from '../../helpers/migrations.js';
import { GitHubSyncService, InMemorySyncState, SqliteSyncState } from '../../../src/modules/github/github-sync-service.js';
import type { SyncState } from '../../../src/modules/github/github-sync-service.js';
import type { GitHosting, PullRequest } from '../../../src/modules/github/git-hosting.js';
import type { Database } from '../../../src/platform/database/database.js';

describe('GitHub sync state persistence', () => {
  let tempDirectory: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  it('reconciles a created PR from durable state after a process restart', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orchestrator-github-sync-'));
    const databasePath = join(tempDirectory, 'orchestrator.db');
    db = createSqliteDatabase(databasePath);
    runMigrations(db, loadTestMigrations());

    let remotePullRequest: PullRequest | undefined;
    const hosting = {
      findPullRequest: vi.fn(async () => ({ status: 'OK' as const, value: remotePullRequest })),
      createPullRequest: vi.fn(async () => {
        remotePullRequest = { id: 987, number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', head: 'task/1', base: 'master' };
        return { status: 'OK' as const, value: remotePullRequest };
      }),
    } as unknown as GitHosting;

    const firstService = new GitHubSyncService(hosting, new SqliteSyncState(db));
    const created = await firstService.ensurePullRequest('o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' });
    expect(created.status).toBe('SUCCEEDED');
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();

    db.close();
    db = createSqliteDatabase(databasePath);
    runMigrations(db, loadTestMigrations());
    const restartedState = new SqliteSyncState(db);
    expect(restartedState.get('task-1')).toMatchObject({ key: 'task-1', repository: 'o/r', status: 'SUCCEEDED' });

    const restartedService = new GitHubSyncService(hosting, restartedState);
    const reconciled = await restartedService.ensurePullRequest('o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' });
    expect(reconciled.status).toBe('SUCCEEDED');
    expect(reconciled.pullRequest?.number).toBe(7);
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
  });

  it('keeps in-memory state available only as an explicit test adapter', () => {
    const state = new InMemorySyncState();
    state.set({ key: 'task-1', repository: 'o/r', marker: 'ORCHESTRATOR:task-1', status: 'PENDING', updatedAt: 1 });
    expect(state.get('task-1')?.status).toBe('PENDING');
  });

  it('finds a remote PR after a crash before the durable acknowledgement', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orchestrator-github-crash-'));
    const databasePath = join(tempDirectory, 'orchestrator.db');
    db = createSqliteDatabase(databasePath);
    runMigrations(db, loadTestMigrations());
    let remotePullRequest: PullRequest | undefined;
    const hosting = {
      findPullRequest: vi.fn(async () => ({ status: 'OK' as const, value: remotePullRequest })),
      createPullRequest: vi.fn(async () => {
        remotePullRequest = { id: 988, number: 8, url: 'https://github.com/o/r/pull/8', state: 'open', head: 'task/2', base: 'master' };
        return { status: 'OK' as const, value: remotePullRequest };
      }),
    } as unknown as GitHosting;
    const interruptedState: SyncState = {
      get: () => undefined,
      set: () => { throw new Error('simulated process interruption before local acknowledgement'); },
    };

    await expect(new GitHubSyncService(hosting, interruptedState).ensurePullRequest(
      'o/r', 'task-2', { head: 'task/2', base: 'master', title: 'Task 2' },
    )).rejects.toThrow('simulated process interruption');
    db.close();
    db = createSqliteDatabase(databasePath);
    runMigrations(db, loadTestMigrations());

    const restarted = await new GitHubSyncService(hosting, new SqliteSyncState(db)).ensurePullRequest(
      'o/r', 'task-2', { head: 'task/2', base: 'master', title: 'Task 2' },
    );
    expect(restarted.pullRequest?.number).toBe(8);
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
  });
});
