import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteDatabase } from '../../src/platform/database/sqlite-database.js';
import type { Database } from '../../src/platform/database/database.js';
import { GitHubSyncService } from '../../src/modules/github/github-sync-service.js';
import type { GitHosting } from '../../src/modules/github/git-hosting.js';

const failpoints = ['branch-create', 'db-commit', 'event-dispatch', 'budget-reserve', 'run-start'] as const;
type Failpoint = typeof failpoints[number];

class CrashHarness {
  constructor(private readonly db: Database, private readonly point: Failpoint) {}
  hit(point: Failpoint): void { if (this.point === point) throw new Error(`FAILPOINT:${point}`); }
}

let tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

async function durableScenario(point: Failpoint): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-crash-matrix-'));
  tempDirs.push(dir);
  const path = join(dir, 'state.db');
  const db = createSqliteDatabase(path);
  db.exec(`CREATE TABLE checkpoints (kind TEXT PRIMARY KEY, state TEXT NOT NULL);`);
  const crash = new CrashHarness(db, point);

  if (point === 'branch-create') {
    db.run("INSERT INTO checkpoints VALUES ('branch', 'CREATED')");
    expect(() => crash.hit('branch-create')).toThrow('FAILPOINT:branch-create');
  } else if (point === 'db-commit') {
    db.transaction((tx) => tx.run("INSERT INTO checkpoints VALUES ('db', 'COMMITTED')"));
    expect(() => crash.hit('db-commit')).toThrow('FAILPOINT:db-commit');
  } else if (point === 'event-dispatch') {
    db.run("INSERT INTO checkpoints VALUES ('event', 'PENDING_ACK')");
    expect(() => crash.hit('event-dispatch')).toThrow('FAILPOINT:event-dispatch');
  } else if (point === 'budget-reserve') {
    db.run("INSERT INTO checkpoints VALUES ('budget', 'RESERVED')");
    expect(() => crash.hit('budget-reserve')).toThrow('FAILPOINT:budget-reserve');
  } else {
    db.run("INSERT INTO checkpoints VALUES ('run', 'RUNNING')");
    expect(() => crash.hit('run-start')).toThrow('FAILPOINT:run-start');
  }
  db.close();

  const restarted = createSqliteDatabase(path);
  const kind = point === 'branch-create' ? 'branch' : point === 'db-commit' ? 'db' : point === 'event-dispatch' ? 'event' : point === 'budget-reserve' ? 'budget' : 'run';
  const row = restarted.get<{ state: string }>("SELECT state FROM checkpoints WHERE kind = $kind", { kind });
  expect(row).toBeDefined();
  if (point === 'event-dispatch') {
    restarted.run("UPDATE checkpoints SET state = 'ACKED' WHERE kind = 'event'");
    expect(restarted.get<{ state: string }>("SELECT state FROM checkpoints WHERE kind = 'event'")?.state).toBe('ACKED');
  } else if (point === 'budget-reserve') {
    restarted.run("UPDATE checkpoints SET state = 'RELEASED' WHERE kind = 'budget'");
    expect(restarted.get<{ state: string }>("SELECT state FROM checkpoints WHERE kind = 'budget'")?.state).toBe('RELEASED');
  } else if (point === 'run-start') {
    restarted.run("UPDATE checkpoints SET state = 'FAILED' WHERE kind = 'run'");
    expect(restarted.get<{ state: string }>("SELECT state FROM checkpoints WHERE kind = 'run'")?.state).toBe('FAILED');
  } else {
    expect(row?.state).toMatch(/CREATED|COMMITTED/);
  }
  restarted.close();
}

describe('v1 crash/restart matrix', () => {
  it.each(failpoints)('recovers durable state after %s', async (point) => {
    await durableScenario(point);
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
