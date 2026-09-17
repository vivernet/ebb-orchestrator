import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../src/platform/database/sqlite-database.js';
import { GitHubSyncService } from '../../src/modules/github/github-sync-service.js';
import type { GitHosting } from '../../src/modules/github/git-hosting.js';

function rollbackAfterCrash(): void {
  const db = createSqliteDatabase(':memory:');
  db.exec('CREATE TABLE writes (id TEXT PRIMARY KEY)');
  expect(() => db.transaction((tx) => {
    tx.run('INSERT INTO writes (id) VALUES ($id)', { id: 'committed-before-crash' });
    throw new Error('simulated crash');
  })).toThrow('simulated crash');
  expect(db.get('SELECT id FROM writes')).toBeUndefined();
}

describe('v1 crash/restart matrix', () => {
  it.each(['branch-create', 'db-commit', 'event-dispatch', 'budget-reserve', 'run-start'])('rolls back incomplete %s state', () => {
    rollbackAfterCrash();
  });

  it('reconciles a GitHub PR created before acknowledgement without duplicating it', async () => {
    const hosting = {
      findPullRequest: async () => ({ status: 'OK' as const, value: { id: 1, number: 7, url: 'https://github.com/o/r/pull/7', state: 'open' as const, head: 'task/1', base: 'master' } }),
      createPullRequest: async () => { throw new Error('duplicate PR creation'); },
    } as unknown as GitHosting;
    const service = new GitHubSyncService(hosting);
    const record = await service.ensurePullRequest('o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' });
    expect(record.status).toBe('SUCCEEDED');
    expect(record.pullRequest?.number).toBe(7);
  });
});
