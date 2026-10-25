import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const NOW = "2026-10-24T12:00:00.000Z";

describe("chat migration 052", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function freshDb(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-chat-migration-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
  }

  function seedPlanningRows(): { requestId: string; planId: string } {
    const projectId = randomUUID();
    const requestId = randomUUID();
    const planId = randomUUID();
    db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
    db!.run(
      "INSERT INTO planning_requests(id,project_id,request,requested_by,created_at) VALUES($id,$projectId,'r','u',$now)",
      { id: requestId, projectId, now: NOW },
    );
    db!.run(
      "INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES($id,$projectId,'{}','APPROVED',0,$now)",
      { id: planId, projectId, now: NOW },
    );
    return { requestId, planId };
  }

  describe("fresh install 001-053", () => {
    it("applies 001-053 and creates chat tables with CHECK/FK/index invariants", async () => {
      await freshDb();
      const migrations = loadTestMigrations();
      expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 53 }, (_, index) => index + 1));
      expect(migrations.at(-1)?.name).toBe("053_scheduler_dispatch_controls");
      expect(runMigrations(db!, migrations).applied).toBe(53);

      expect(db!.all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>(
        "PRAGMA table_info(chat_conversations)",
      ).map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))).toEqual([
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "project_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "title", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, dflt_value: "'ACTIVE'", pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ]);

      expect(db!.all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>(
        "PRAGMA table_info(chat_messages)",
      ).map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))).toEqual([
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "conversation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "role", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "content", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "request_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { name: "plan_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { name: "status", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ]);

      // Индекс по (conversation_id, created_at) — опора cursor-пагинации.
      expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_chat_messages_conv'")?.sql)
        .toContain("chat_messages(conversation_id, created_at)");
      expect(db!.all<{ seqno: number; cid: number; name: string }>("PRAGMA index_info(idx_chat_messages_conv)"))
        .toEqual([
          { seqno: 0, cid: 1, name: "conversation_id" },
          { seqno: 1, cid: 8, name: "created_at" },
        ]);

      const projectId = randomUUID();
      db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
      const conversationId = randomUUID();
      db!.run(
        "INSERT INTO chat_conversations(id,project_id,title,status,created_at,updated_at) VALUES($id,$projectId,'Chat','ACTIVE',$now,$now)",
        { id: conversationId, projectId, now: NOW },
      );

      // CHECK: статус беседы ограничен ACTIVE.
      expect(() => db!.run(
        "INSERT INTO chat_conversations(id,project_id,title,status,created_at,updated_at) VALUES($id,$projectId,'X','BOGUS',$now,$now)",
        { id: randomUUID(), projectId, now: NOW },
      )).toThrow(/CHECK constraint failed/i);

      const insertMessage = (overrides: Record<string, unknown>): void => {
        db!.run(
          `INSERT INTO chat_messages(id,conversation_id,role,kind,content,request_id,plan_id,status,created_at)
           VALUES($id,$conversationId,$role,$kind,$content,$requestId,$planId,$status,$now)`,
          { id: randomUUID(), conversationId, role: "user", kind: "text", content: "hi", requestId: null, planId: null, status: null, now: NOW, ...overrides },
        );
      };

      // CHECK: роли/виды/статусы ограничены контрактом.
      expect(() => insertMessage({ role: "admin" })).toThrow(/CHECK constraint failed/i);
      expect(() => insertMessage({ kind: "bogus" })).toThrow(/CHECK constraint failed/i);
      expect(() => insertMessage({ status: "BOGUS" })).toThrow(/CHECK constraint failed/i);
      insertMessage({ role: "coordinator", kind: "approval_request", status: "PLAN_PENDING_APPROVAL" });
      insertMessage({ kind: "status_update", status: null });

      // FK: project/conversation/plan request ссылки обязаны существовать.
      expect(() => db!.run(
        "INSERT INTO chat_conversations(id,project_id,title,status,created_at,updated_at) VALUES($id,'missing','Chat','ACTIVE',$now,$now)",
        { id: randomUUID(), now: NOW },
      )).toThrow(/FOREIGN KEY/);
      expect(() => insertMessage({ conversationId: randomUUID() })).toThrow(/FOREIGN KEY/);
      expect(() => insertMessage({ requestId: randomUUID() })).toThrow(/FOREIGN KEY/);
      expect(() => insertMessage({ planId: randomUUID() })).toThrow(/FOREIGN KEY/);

      const { requestId, planId } = seedPlanningRows();
      const linkedId = randomUUID();
      db!.run(
        `INSERT INTO chat_messages(id,conversation_id,role,kind,content,request_id,plan_id,status,created_at)
         VALUES($id,$conversationId,'coordinator','status_update','ok',$requestId,$planId,'RECEIVED',$now)`,
        { id: linkedId, conversationId, requestId, planId, now: NOW },
      );
      expect(db!.get(
        "SELECT role,kind,request_id,plan_id,status FROM chat_messages WHERE id=$id",
        { id: linkedId },
      )).toEqual({ role: "coordinator", kind: "status_update", request_id: requestId, plan_id: planId, status: "RECEIVED" });

      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db!.get<{ applied: number }>("SELECT COUNT(*) AS applied FROM schema_migrations")!.applied).toBe(53);
    });
  });

  describe("populated upgrade 051 -> 052", () => {
    it("adds chat tables without touching existing rows or historical schema", async () => {
      await freshDb();
      const migrations = loadTestMigrations();
      const through051 = migrations.filter(({ version }) => version <= 51);
      expect(runMigrations(db!, through051).applied).toBe(51);
      expect(db!.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_conversations'")).toBeUndefined();
      expect(db!.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'")).toBeUndefined();

      const { requestId, planId } = seedPlanningRows();
      db!.run(
        "INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'developer','hermes','test-model','COMPLETED')",
        { id: randomUUID() },
      );
      const projectsBefore = db!.all("SELECT * FROM projects");
      const requestsBefore = db!.all("SELECT * FROM planning_requests");
      const plansBefore = db!.all("SELECT * FROM planning_plans");

      expect(runMigrations(db!, migrations).applied).toBe(2);
      expect(db!.all("SELECT * FROM projects")).toEqual(projectsBefore);
      expect(db!.all("SELECT * FROM planning_requests")).toEqual(requestsBefore);
      expect(db!.all("SELECT * FROM planning_plans")).toEqual(plansBefore);

      // Новые таблицы доступны сразу после upgrade.
      const projectId = randomUUID();
      db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
      const conversationId = randomUUID();
      db!.run(
        "INSERT INTO chat_conversations(id,project_id,title,status,created_at,updated_at) VALUES($id,$projectId,'Chat','ACTIVE',$now,$now)",
        { id: conversationId, projectId, now: NOW },
      );
      db!.run(
        `INSERT INTO chat_messages(id,conversation_id,role,kind,content,request_id,plan_id,status,created_at)
         VALUES($id,$conversationId,'user','text','hello',$requestId,$planId,NULL,$now)`,
        { id: randomUUID(), conversationId, requestId, planId, now: NOW },
      );
      expect(db!.get("SELECT COUNT(*) AS count FROM chat_messages")!.count).toBe(1);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);

      // Повторный прогон каталога ничего не применяет и подтверждает
      // неизменность checksum исторических миграций 001-051.
      expect(runMigrations(db!, migrations).applied).toBe(0);
    });
  });
});
