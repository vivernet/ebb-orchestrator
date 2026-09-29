import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { appendOutboxEvent } from "../../src/platform/events/outbox-repository.js";
import { DomainEvent } from "../../src/platform/events/domain-event.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import { GitHubSyncService, SqliteSyncState } from "../../src/modules/github/github-sync-service.js";
import type { GitHosting, PullRequest } from "../../src/modules/github/git-hosting.js";

describe('v1 production recovery paths', () => {
  let tempDirectory: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  async function openDatabase(): Promise<Database> {
    tempDirectory ??= await mkdtemp(join(tmpdir(), 'orchestrator-v1-recovery-'));
    const database = createSqliteDatabase(join(tempDirectory, 'state.db'));
    runMigrations(database, loadTestMigrations());
    return database;
  }

  it('acknowledges a delivered outbox event after restart without repeating its consumer', async () => {
    db = await openDatabase();
    const event = DomainEvent.create({ type: 'recovery.test', payload: { id: 'one' } });
    db.transaction((tx) => appendOutboxEvent(tx, event));

    // Models the durable state after a consumer has completed and recorded its receipt,
    // but the process stopped before marking the outbox row processed.
    db.run(
      'INSERT INTO processed_events (consumer_name, event_id, processed_at) VALUES ($consumer, $event, $at)',
      { consumer: 'recovery-consumer', event: event.id, at: new Date().toISOString() },
    );
    db.close();
    db = await openDatabase();

    const handler = vi.fn();
    const bus = new EventBus();
    bus.subscribe(event.type, 'recovery-consumer', handler);
    expect(await new EventDispatcher(db, bus).dispatchBatch(10)).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM outbox_events WHERE id = $id', { id: event.id },
    )?.processed_at).toEqual(expect.any(String));
  });

  it('marks a durable in-progress run interrupted and clears its capability after restart', async () => {
    db = await openDatabase();
    const runService = new RunService(db, new FakeAgentRuntime());
    const run = runService.prepareRun({
      runId: randomUUID(), role: 'developer', model: 'test-model', taskId: randomUUID(), epicId: randomUUID(),
      triggerReason: 'task-assignment', contextVersion: '1', outputSchemaVersion: '1',
    });
    db.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: run.id });
    db.close();
    db = await openDatabase();

    expect(new RunService(db, new FakeAgentRuntime()).reconcileInterruptedRuns()).toBe(1);
    expect(db.get<{ status: string; capability_ref: string | null }>(
      'SELECT status, capability_ref FROM agent_runs WHERE id=$id', { id: run.id },
    )).toEqual({ status: 'FAILED', capability_ref: null });
  });

  it('finds the remote PR after local acknowledgement fails and does not create a duplicate', async () => {
    db = await openDatabase();
    let remotePullRequest: PullRequest | undefined;
    const hosting = {
      findPullRequest: vi.fn(async () => ({ status: 'OK' as const, value: remotePullRequest })),
      createPullRequest: vi.fn(async () => {
        remotePullRequest = { id: 987, number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', head: 'task/1', base: 'master' };
        return { status: 'OK' as const, value: remotePullRequest };
      }),
    } as unknown as GitHosting;
    const state = new SqliteSyncState(db);
    vi.spyOn(state, 'set').mockImplementation(() => { throw new Error('simulated interruption before local acknowledgement'); });

    await expect(new GitHubSyncService(hosting, state).ensurePullRequest(
      'o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' },
    )).rejects.toThrow('simulated interruption');
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
    db.close();
    db = await openDatabase();

    const recovered = await new GitHubSyncService(hosting, new SqliteSyncState(db)).ensurePullRequest(
      'o/r', 'task-1', { head: 'task/1', base: 'master', title: 'Task 1' },
    );
    expect(recovered.status).toBe('SUCCEEDED');
    expect(recovered.pullRequest?.number).toBe(7);
    expect(hosting.createPullRequest).toHaveBeenCalledOnce();
  });
});
