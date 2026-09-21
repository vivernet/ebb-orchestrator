import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { KnowledgeService } from "../../../src/modules/knowledge/knowledge-service.js";
import { parseGuideline, validateGuideline } from "../../../src/modules/knowledge/guideline-parser.js";
import { parseDecision, validateDecision } from "../../../src/modules/knowledge/decision-parser.js";

const GUIDELINE_MARKDOWN = `---
id: GL-ARCH-014
category: ARCH
version: 1
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer,architect
rationale: All API endpoints must use versioned paths.
provenance: team-decision
content_hash: abc123
superseded_by:
---
# API versioning

All API endpoints must use versioned paths (e.g. /v1/...).
`;

const GUIDELINE_V2_MARKDOWN = `---
id: GL-ARCH-014
category: ARCH
version: 2
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer,architect
rationale: All API endpoints must use versioned paths. V2 clarifies patch format.
provenance: team-decision
content_hash: def456
superseded_by:
---
# API versioning V2

All API endpoints must use versioned paths. Patch format: /v1/resource/:id.
`;

const DECISION_MARKDOWN = `---
id: DEC-0001
status: ACCEPTED
scope: EPIC
title: Use SQLite for local storage
rationale: SQLite is zero-config, embedded, and sufficient for v1.
related_guideline:
---
# Use SQLite for local storage

We chose SQLite because it requires no external services.
`;

const DECISION_MARKDOWN_2 = `---
id: DEC-0002
status: PROPOSED
scope: PROJECT
title: Prefer functional composition
rationale: More testable code.
related_guideline: GL-ARCH-014
---
# Prefer functional composition
`;

describe("KnowledgeService", () => {
  let db: Database | undefined;
  let dir = "";
  afterEach(async () => {
    db?.close();
    db = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ service: KnowledgeService; projectId: string; repoDir: string }> {
    dir = await mkdtemp(join(tmpdir(), "orch-knowledge-test-"));
    db = createSqliteDatabase(join(dir, "test.db"));
  // Нужны только миграции: 001 (outbox_events, schema_migrations),
  // 002 (projects), 015 (таблицы knowledge).
    const names = ["001_system", "002_work_domain", "015_knowledge"];
    const migrations: Migration[] = names.map((name, i) => ({
      version: i === 2 ? 15 : i + 1,
      name,
      sql: readFileSync(join(import.meta.dirname, `../../../src/platform/database/migrations/${name}.sql`), "utf8"),
    }));
    runMigrations(db, migrations);
    const projectId = randomUUID();
    db.run(
      "INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'p','P','ACTIVE',$now,$now)",
      { id: projectId, now: new Date().toISOString() },
    );
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    return { service: new KnowledgeService(db), projectId, repoDir };
  }

  // ── Разбор guideline ───────────────────────────────────────────────

  describe("parseGuideline", () => {
    it("parses a valid guideline markdown with YAML front matter", () => {
      const result = parseGuideline(GUIDELINE_MARKDOWN);
      expect(result.id).toBe("GL-ARCH-014");
      expect(result.category).toBe("ARCH");
      expect(result.version).toBe(1);
      expect(result.priority).toBe("REQUIRED");
      expect(result.status).toBe("ACTIVE");
      expect(result.scope).toBe("project");
      expect(result.applicableRoles).toEqual(["developer", "architect"]);
      expect(result.rationale).toBe("All API endpoints must use versioned paths.");
      expect(result.contentHash).toBe("abc123");
    });

    it("rejects a guideline with a malformed ID", () => {
      const bad = GUIDELINE_MARKDOWN.replace("GL-ARCH-014", "BAD-ID");
      expect(() => parseGuideline(bad)).toThrow(/invalid.*id/i);
    });

    it("rejects a guideline with an unknown priority", () => {
      const bad = GUIDELINE_MARKDOWN.replace("priority: REQUIRED", "priority: CRITICAL");
      expect(() => parseGuideline(bad)).toThrow(/priority/i);
    });

    it("rejects a guideline with an unknown status", () => {
      const bad = GUIDELINE_MARKDOWN.replace("status: ACTIVE", "status: LIVE");
      expect(() => parseGuideline(bad)).toThrow(/status/i);
    });
  });

  describe("validateGuideline", () => {
    it("passes for a well-formed guideline", () => {
      const parsed = parseGuideline(GUIDELINE_MARKDOWN);
      expect(() => validateGuideline(parsed)).not.toThrow();
    });

    it("fails when superseded_by has an invalid ID format", () => {
      const parsed = parseGuideline(GUIDELINE_MARKDOWN);
      parsed.supersededBy = "INVALID-ID";
      expect(() => validateGuideline(parsed)).toThrow(/superseded_by/i);
    });
  });

  // ── Разбор decision ────────────────────────────────────────────────

  describe("parseDecision", () => {
    it("parses a valid decision markdown", () => {
      const result = parseDecision(DECISION_MARKDOWN);
      expect(result.id).toBe("DEC-0001");
      expect(result.status).toBe("ACCEPTED");
      expect(result.scope).toBe("EPIC");
      expect(result.title).toBe("Use SQLite for local storage");
    });

    it("rejects a decision with a malformed ID", () => {
      const bad = DECISION_MARKDOWN.replace("DEC-0001", "BAD");
      expect(() => parseDecision(bad)).toThrow(/invalid.*id/i);
    });

    it("rejects a decision with an unknown status", () => {
      const bad = DECISION_MARKDOWN.replace("status: ACCEPTED", "status: LIVE");
      expect(() => parseDecision(bad)).toThrow(/status/i);
    });
  });

  describe("validateDecision", () => {
    it("passes for a well-formed decision", () => {
      const parsed = parseDecision(DECISION_MARKDOWN);
      expect(() => validateDecision(parsed)).not.toThrow();
    });
  });

  // ── KnowledgeService — индексация и жизненный цикл ──────────────────

  describe("indexRepository", () => {
    it("indexes guideline and decision markdown files from the repo", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      const decDir = join(repoDir, "decisions");
      await mkdir(glDir, { recursive: true });
      await mkdir(decDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await writeFile(join(decDir, "DEC-0001.md"), DECISION_MARKDOWN);

      const result = await service.indexRepository(projectId, repoDir);
      expect(result.guidelinesIndexed).toBe(1);
      expect(result.decisionsIndexed).toBe(1);

      const rows = db?.all<{ display_id: string; status: string; version: number }>(
        "SELECT display_id, status, version FROM knowledge_guidelines ORDER BY display_id",
      );
      expect(rows).toHaveLength(1);
      expect(rows![0]!.display_id).toBe("GL-ARCH-014");
      expect(rows![0]!.status).toBe("ACTIVE");
      expect(rows![0]!.version).toBe(1);

      const decRows = db?.all<{ display_id: string; status: string }>(
        "SELECT display_id, status FROM knowledge_decisions ORDER BY display_id",
      );
      expect(decRows).toHaveLength(1);
      expect(decRows![0]!.display_id).toBe("DEC-0001");
    });

    it("rejects duplicate guideline IDs during indexing", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await writeFile(join(glDir, "GL-ARCH-014-copy.md"), GUIDELINE_MARKDOWN);

      await expect(service.indexRepository(projectId, repoDir)).rejects.toThrow(/duplicate.*id/i);
    });

    it("detects external semantic changes as PENDING_EXTERNAL_CHANGE", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });

  // Сначала индексируем v1.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Меняем content hash, имитируя внешнее редактирование.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_V2_MARKDOWN);
      const result = await service.indexRepository(projectId, repoDir);

      expect(result.guidelinesIndexed).toBe(1);
      const rows = db?.all<{ status: string; version: number; content_hash: string }>(
        "SELECT status, version, content_hash FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' ORDER BY version",
      );
  // v1 остаётся ACTIVE (без изменений), v2 получает PENDING_EXTERNAL_CHANGE.
      expect(rows).toHaveLength(2);
      expect(rows![0]!.status).toBe("ACTIVE");
      expect(rows![0]!.version).toBe(1);
      expect(rows![1]!.status).toBe("PENDING_EXTERNAL_CHANGE");
      expect(rows![1]!.version).toBe(2);
      expect(rows![1]!.content_hash).toBe("def456");
    });
  });

  describe("activeForScope", () => {
    it("returns only ACTIVE guidelines for the given scope", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

      const active = service.activeForScope(projectId, { scope: "project" });
      expect(active).toHaveLength(1);
      expect(active[0]!.displayId).toBe("GL-ARCH-014");
    });

    it("excludes SUPERSEDED guidelines from active results", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });

  // Индексируем v1 как ACTIVE.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Индексируем v2 с другим content hash → PENDING_EXTERNAL_CHANGE.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_V2_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Одобряем v2 → v2 становится ACTIVE, v1 — SUPERSEDED.
      const v2Row = db?.get<{ id: string }>(
        "SELECT id FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' AND version=2",
      );
      service.applyApprovedProposal(v2Row!.id);

  // Активной должна оставаться только v2.
      const active = service.activeForScope(projectId, { scope: "project" });
      expect(active).toHaveLength(1);
      expect(active[0]!.displayId).toBe("GL-ARCH-014");
    });

    it("superseded versions remain in the database as historical records", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });

  // Индексируем v1 как ACTIVE.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Индексируем v2 с другим content hash → PENDING_EXTERNAL_CHANGE.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_V2_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Одобряем v2 → v2 становится ACTIVE, v1 — SUPERSEDED.
      const v2Row = db?.get<{ id: string }>(
        "SELECT id FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' AND version=2",
      );
      service.applyApprovedProposal(v2Row!.id);

  // Обе версии остаются в базе как исторические записи.
      const all = db?.all<{ display_id: string; status: string; version: number }>(
        "SELECT display_id, status, version FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' ORDER BY version",
      );
      expect(all).toHaveLength(2);
      expect(all![0]!.status).toBe("SUPERSEDED");
      expect(all![0]!.version).toBe(1);
      expect(all![1]!.status).toBe("ACTIVE");
      expect(all![1]!.version).toBe(2);
    });

    it("returns only ACCEPTED decisions in active scope", async () => {
      const { service, repoDir, projectId } = await setup();
      const decDir = join(repoDir, "decisions");
      await mkdir(decDir, { recursive: true });
      await writeFile(join(decDir, "DEC-0001.md"), DECISION_MARKDOWN);
      await writeFile(join(decDir, "DEC-0002.md"), DECISION_MARKDOWN_2);
      await service.indexRepository(projectId, repoDir);

      const active = service.activeForScope(projectId, { scope: "project" });
  // DEC-0001 имеет статус ACCEPTED и область EPIC, DEC-0002 — PROPOSED и область PROJECT.
      expect(active).toHaveLength(1);
      expect(active[0]!.displayId).toBe("DEC-0002");
      expect(active[0]!.status).toBe("PROPOSED");
    });

    it("filters active guidelines by applicable role", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

      const activeDev = service.activeForScope(projectId, { role: "developer" });
      expect(activeDev).toHaveLength(1);

      const activePM = service.activeForScope(projectId, { role: "product-manager" });
      expect(activePM).toHaveLength(0);
    });
  });

  describe("applyApprovedProposal", () => {
    it("transitions a guideline to ACTIVE when proposal is approved", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

  // Предлагаем новую версию как PENDING_EXTERNAL_CHANGE.
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_V2_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

      const row = db?.get<{ id: string; status: string; version: number }>(
        "SELECT id, status, version FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' AND version=2",
      );
      expect(row?.status).toBe("PENDING_EXTERNAL_CHANGE");

  // Одобряем её.
      service.applyApprovedProposal(row!.id);

      const approved = db?.get<{ status: string }>(
        "SELECT status FROM knowledge_guidelines WHERE id=$id",
        { id: row!.id },
      );
      expect(approved?.status).toBe("ACTIVE");

  // Старая версия теперь должна иметь статус SUPERSEDED.
      const old = db?.get<{ status: string; version: number }>(
        "SELECT status, version FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' AND version=1",
      );
      expect(old?.status).toBe("SUPERSEDED");
    });

    it("throws when applying a proposal for a non-existent item", async () => {
      const { service } = await setup();
      expect(() => service.applyApprovedProposal("non-existent-id")).toThrow(/not found/i);
    });
  });

  describe("lifecycle transitions", () => {
    it("guideline status PROPOSED -> UNDER_REVIEW -> ACTIVE lifecycle", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });

      const proposedMd = GUIDELINE_MARKDOWN.replace("status: ACTIVE", "status: PROPOSED");
      await writeFile(join(glDir, "GL-ARCH-014.md"), proposedMd);
      await service.indexRepository(projectId, repoDir);

      const row = db?.get<{ status: string; id: string }>(
        "SELECT status, id FROM knowledge_guidelines WHERE display_id='GL-ARCH-014'",
      );
      expect(row?.status).toBe("PROPOSED");

  // Переходим в UNDER_REVIEW.
      service.updateStatus(row!.id, "UNDER_REVIEW");
      const review = db?.get<{ status: string }>(
        "SELECT status FROM knowledge_guidelines WHERE id=$id",
        { id: row!.id },
      );
      expect(review?.status).toBe("UNDER_REVIEW");

  // Переходим в ACTIVE.
      service.updateStatus(row!.id, "ACTIVE");
      const active = db?.get<{ status: string }>(
        "SELECT status FROM knowledge_guidelines WHERE id=$id",
        { id: row!.id },
      );
      expect(active?.status).toBe("ACTIVE");
    });

    it("rejects invalid status transitions", async () => {
      const { service, repoDir, projectId } = await setup();
      const glDir = join(repoDir, "guidelines");
      await mkdir(glDir, { recursive: true });
      await writeFile(join(glDir, "GL-ARCH-014.md"), GUIDELINE_MARKDOWN);
      await service.indexRepository(projectId, repoDir);

      const row = db?.get<{ id: string }>(
        "SELECT id FROM knowledge_guidelines WHERE display_id='GL-ARCH-014' AND status='ACTIVE'",
      );
  // Из ACTIVE нельзя вернуться в PROPOSED.
      expect(() => service.updateStatus(row!.id, "PROPOSED")).toThrow(/invalid.*transition/i);
    });
  });
});
