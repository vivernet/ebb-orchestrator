import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../../src/platform/database/database.js";
import { runMigrations } from "../../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../../helpers/migrations.js";
import { TracingStore } from "../../../../src/modules/runtime/tracing/tracing-store.js";
import { TRACE_VERSION, type TracingPayload } from "../../../../src/modules/runtime/tracing/tracing-payload.js";

describe("TracingStore", () => {
  let db: Database | undefined;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupDb(): Promise<{ store: TracingStore }> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-tracing-store-"));
    const database = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(database, loadTestMigrations());
    db = database;
    return { store: new TracingStore(database) };
  }

  function insertRun(runId: string): void {
    db!.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'developer','hermes','test-model','COMPLETED')",
      { id: runId },
    );
  }

  function payload(overrides: Partial<TracingPayload> = {}): TracingPayload {
    return {
      runId: randomUUID(),
      scenario: "task-assignment",
      promptHash: "a".repeat(64),
      contextHash: "b".repeat(64),
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, cost: 0.01 },
      createdAt: "2026-10-23T12:00:00.000Z",
      version: TRACE_VERSION,
      ...overrides,
    };
  }

  it("inserts a new trace and returns inserted", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    const p = payload({ runId });
    expect(store.save(p)).toBe("inserted");
    expect(db!.get<{
      run_id: string; scenario: string | null; prompt_hash: string; context_hash: string;
      usage_json: string | null; created_at: string; version: string;
    }>("SELECT run_id,scenario,prompt_hash,context_hash,usage_json,created_at,version FROM run_traces WHERE run_id=$runId", { runId }))
      .toEqual({
        run_id: runId, scenario: "task-assignment", prompt_hash: p.promptHash, context_hash: p.contextHash,
        usage_json: JSON.stringify(p.usage), created_at: p.createdAt, version: TRACE_VERSION,
      });
  });

  it("stores unknown usage as SQL NULL", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    expect(store.save(payload({ runId, usage: null }))).toBe("inserted");
    expect(db!.get<{ usage_json: string | null }>("SELECT usage_json FROM run_traces WHERE run_id=$runId", { runId })!.usage_json)
      .toBeNull();
  });

  it("treats an identical repeated save as an idempotent no-op", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    const p = payload({ runId });
    expect(store.save(p)).toBe("inserted");
    expect(store.save(p)).toBe("idempotent");
    expect(db!.all("SELECT * FROM run_traces")).toHaveLength(1);
  });

  it("returns a stable conflict without updating when the same run gets a different payload", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    const p = payload({ runId });
    expect(store.save(p)).toBe("inserted");
    const stored = db!.get("SELECT * FROM run_traces WHERE run_id=$runId", { runId });

    for (const different of [
      payload({ runId, promptHash: "c".repeat(64) }),
      payload({ runId, contextHash: "d".repeat(64) }),
      payload({ runId, scenario: "epic-phase" }),
      payload({ runId, scenario: null }),
      payload({ runId, usage: null }),
      payload({ runId, createdAt: "2026-10-23T13:00:00.000Z" }),
    ]) {
      expect(store.save(different)).toBe("conflict");
      expect(db!.get("SELECT * FROM run_traces WHERE run_id=$runId", { runId })).toEqual(stored);
    }
  });

  it("validates payloads and rejects invalid ones with the fixed code", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    expect(() => store.save(payload({ runId, promptHash: "SHORT" }))).toThrow("TRACE_PAYLOAD_INVALID");
    expect(() => store.save(payload({ runId: "not-a-uuid" }))).toThrow("TRACE_PAYLOAD_INVALID");
    expect(db!.all("SELECT * FROM run_traces")).toEqual([]);
  });

  it("enforces the run FK and cascades deletion with the parent Run", async () => {
    const { store } = await setupDb();
    const runId = randomUUID();
    insertRun(runId);
    expect(store.save(payload({ runId }))).toBe("inserted");
    expect(() => store.save(payload())).toThrow(/FOREIGN KEY/);
    db!.run("DELETE FROM agent_runs WHERE id=$runId", { runId });
    expect(db!.all("SELECT * FROM run_traces")).toEqual([]);
    expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
