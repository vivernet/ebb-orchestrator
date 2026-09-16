import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { appendOutboxEvent } from "../../../src/platform/events/outbox-repository.js";
import { DomainEvent, type DomainEventInput } from "../../../src/platform/events/domain-event.js";
import { EventBus } from "../../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../../src/platform/events/event-dispatcher.js";

const migration001 = await readFile(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
];

function createTestEvent(overrides?: Partial<DomainEventInput>): DomainEvent {
  return DomainEvent.create({
    type: "test.entity.created",
    payload: { id: 1, name: "test" },
    ...overrides,
  });
}

describe("transactional outbox", () => {
  let db: Database | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-outbox-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  it("rolls back state write and outbox event together when callback throws", async () => {
    db = await setupDb();
    const event = createTestEvent();
    const now = new Date().toISOString();

    expect(() =>
      db!.transaction((tx) => {
        tx.run(
          "INSERT INTO system_state(key, value_json, updated_at) VALUES ($key, $value_json, $updated_at)",
          { key: "x", value_json: "{}", updated_at: now },
        );
        appendOutboxEvent(tx, event);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(db.get("SELECT key FROM system_state WHERE key = $key", { key: "x" })).toBeUndefined();
    expect(
      db.get("SELECT id FROM outbox_events WHERE id = $id", { id: event.id }),
    ).toBeUndefined();
  });

  it("commits state write and outbox event together on success", async () => {
    db = await setupDb();
    const event = createTestEvent();
    const now = new Date().toISOString();

    db.transaction((tx) => {
      tx.run(
        "INSERT INTO system_state(key, value_json, updated_at) VALUES ($key, $value_json, $updated_at)",
        { key: "y", value_json: '{"ok":true}', updated_at: now },
      );
      appendOutboxEvent(tx, event);
    });

    expect(db.get("SELECT key FROM system_state WHERE key = $key", { key: "y" })).toBeDefined();
    expect(
      db.get<{ id: string }>("SELECT id FROM outbox_events WHERE id = $id", { id: event.id }),
    ).toEqual({ id: event.id });
  });

  it("dispatches event to subscriber exactly once (idempotency)", async () => {
    db = await setupDb();
    const bus = new EventBus();
    let handlerCallCount = 0;

    bus.subscribe("test.entity.created", "audit", async (event) => {
      handlerCallCount++;
    });

    const dispatcher = new EventDispatcher(db, bus);
    const event = createTestEvent();

    // Write the event into outbox
    db.transaction((tx) => {
      appendOutboxEvent(tx, event);
    });

    // Dispatch once - should call handler
    const dispatched1 = await dispatcher.dispatchBatch(100);
    expect(dispatched1).toBe(1);
    expect(handlerCallCount).toBe(1);

    // Dispatch again for the same event - handler should NOT be called again
    const dispatched2 = await dispatcher.dispatchBatch(100);
    expect(dispatched2).toBe(0);
    expect(handlerCallCount).toBe(1);

    // Verify exactly one row in processed_events
    const rows = db.all<{ consumer_name: string; event_id: string }>(
      "SELECT consumer_name, event_id FROM processed_events WHERE consumer_name = $consumer AND event_id = $event_id",
      { consumer: "audit", event_id: event.id },
    );
    expect(rows).toHaveLength(1);
  });

  it("dispatches to multiple consumers independently", async () => {
    db = await setupDb();
    const bus = new EventBus();
    const auditCalls: string[] = [];
    const indexCalls: string[] = [];

    bus.subscribe("test.entity.created", "audit", async (event) => {
      auditCalls.push(event.id);
    });
    bus.subscribe("test.entity.created", "index", async (event) => {
      indexCalls.push(event.id);
    });

    const dispatcher = new EventDispatcher(db, bus);
    const event = createTestEvent();

    db.transaction((tx) => {
      appendOutboxEvent(tx, event);
    });

    const dispatched = await dispatcher.dispatchBatch(100);
    expect(dispatched).toBe(1);
    expect(auditCalls).toHaveLength(1);
    expect(indexCalls).toHaveLength(1);

    // Verify processed_events has two rows
    const rows = db.all<{ consumer_name: string }>(
      "SELECT consumer_name FROM processed_events WHERE event_id = $event_id",
      { event_id: event.id },
    );
    expect(rows.map((r) => r.consumer_name).sort()).toEqual(["audit", "index"]);
  });

  it("leaves event pending when handler throws and increments attempts", async () => {
    db = await setupDb();
    const bus = new EventBus();

    bus.subscribe("test.entity.created", "flaky", async () => {
      throw new Error("handler exploded");
    });

    const dispatcher = new EventDispatcher(db, bus);
    const event = createTestEvent();

    db.transaction((tx) => {
      appendOutboxEvent(tx, event);
    });

    const dispatched = await dispatcher.dispatchBatch(100);
    expect(dispatched).toBe(0);

    // The event should still be pending with attempts incremented
    const row = db.get<{ attempts: number; processed_at: string | null }>(
      "SELECT attempts, processed_at FROM outbox_events WHERE id = $id",
      { id: event.id },
    );
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(1);
    expect(row!.processed_at).toBeNull();

    // No processed_events row for this consumer
    const processed = db.all<{ consumer_name: string }>(
      "SELECT consumer_name FROM processed_events WHERE event_id = $event_id",
      { event_id: event.id },
    );
    expect(processed).toHaveLength(0);
  });

  it("respects batch limit", async () => {
    db = await setupDb();
    const bus = new EventBus();
    const dispatchedIds: string[] = [];

    bus.subscribe("test.entity.created", "collector", async (event) => {
      dispatchedIds.push(event.id);
    });

    const dispatcher = new EventDispatcher(db, bus);

    const events = [createTestEvent(), createTestEvent(), createTestEvent()];
    db.transaction((tx) => {
      for (const event of events) {
        appendOutboxEvent(tx, event);
      }
    });

    // Dispatch only 2 at a time
    const batch1 = await dispatcher.dispatchBatch(2);
    expect(batch1).toBe(2);
    expect(dispatchedIds).toHaveLength(2);

    const batch2 = await dispatcher.dispatchBatch(2);
    expect(batch2).toBe(1);
    expect(dispatchedIds).toHaveLength(3);
  });
});
