/**
 * Knowledge Service – indexes Guidelines and Decisions from repository
 * Markdown files into the database, manages lifecycle transitions, and
 * queries active items by scope.
 *
 * Canonical text stays in the Markdown files; the DB stores searchable
 * metadata, version, hash, and provenance.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import {
  type ParsedGuideline,
  type ParsedDecision,
  type GuidelineStatus,
  type DecisionStatus,
  type IndexResult,
  type ScopeFilter,
  GUIDELINE_STATUS_TRANSITIONS,
  DECISION_STATUS_TRANSITIONS,
} from "./knowledge-types.js";
import { parseGuideline, validateGuideline } from "./guideline-parser.js";
import { parseDecision, validateDecision } from "./decision-parser.js";

export class KnowledgeService {
  constructor(private readonly db: Database) {}

  // ── Repository indexing ──────────────────────────────────────────

  /**
   * Scan a repository directory for guideline and decision Markdown files
   * and index them into the database.
   *
   * Expected directory layout:
   *   <repoDir>/guidelines/*.md   – guideline files
   *   <repoDir>/decisions/*.md    – decision files
   */
  async indexRepository(projectId: string, repoDir: string): Promise<IndexResult> {
    const glDir = join(repoDir, "guidelines");
    const decDir = join(repoDir, "decisions");
    const [glFiles, decFiles] = await Promise.all([
      readMarkdownFiles(glDir),
      readMarkdownFiles(decDir),
    ]);

    let guidelinesIndexed = 0;
    let decisionsIndexed = 0;

    this.db.transaction((tx) => {
      // Track IDs seen in this batch to detect duplicates
      const seenGlIds = new Set<string>();
      const seenDecIds = new Set<string>();

      for (const file of glFiles) {
        const parsed = parseGuideline(file.content);
        validateGuideline(parsed);

        // Duplicate detection within this batch
        if (seenGlIds.has(parsed.id)) {
          throw new Error(`Duplicate guideline ID "${parsed.id}" in index batch.`);
        }
        seenGlIds.add(parsed.id);

        this.upsertGuideline(tx, projectId, parsed, file.relativePath);
        guidelinesIndexed++;
      }

      for (const file of decFiles) {
        const parsed = parseDecision(file.content);
        validateDecision(parsed);

        if (seenDecIds.has(parsed.id)) {
          throw new Error(`Duplicate decision ID "${parsed.id}" in index batch.`);
        }
        seenDecIds.add(parsed.id);

        this.upsertDecision(tx, projectId, parsed, file.relativePath);
        decisionsIndexed++;
      }
    });

    return { guidelinesIndexed, decisionsIndexed };
  }

  // ── Active scope queries ─────────────────────────────────────────

  /**
   * Return active knowledge items for the given scope filter.
   * For guidelines: ACTIVE status only.
   * For decisions: ACCEPTED or PROPOSED status (per spec, proposed decisions
   * are still visible as they may be in-progress choices).
   */
  activeForScope(
    projectId: string,
    filter: ScopeFilter = {},
  ): Array<{ displayId: string; type: "guideline" | "decision"; status: string; [key: string]: unknown }> {
    const results: Array<{ displayId: string; type: "guideline" | "decision"; status: string; [key: string]: unknown }> = [];

    // Active guidelines
    let glSql = "SELECT * FROM knowledge_guidelines WHERE project_id=$projectId AND status='ACTIVE'";
    const glParams: Record<string, string> = { $projectId: projectId };

    if (filter.scope) {
      glSql += " AND scope=$scope";
      glParams.$scope = filter.scope;
    }
    if (filter.category) {
      glSql += " AND category=$category";
      glParams.$category = filter.category;
    }
    if (filter.role) {
      glSql += " AND applicable_roles LIKE $rolePattern";
      glParams.$rolePattern = `%${filter.role}%`;
    }

    const glRows = this.db.all<GuidelineRow>(glSql, glParams);
    for (const row of glRows) {
      results.push({
        displayId: row.display_id,
        type: "guideline",
        status: row.status,
        category: row.category,
        version: row.version,
        priority: row.priority,
        scope: row.scope,
        rationale: row.rationale,
      });
    }

    // Decisions: ACCEPTED and PROPOSED are considered "active" (visible in context)
    let decSql = "SELECT * FROM knowledge_decisions WHERE project_id=$projectId AND status IN ('ACCEPTED','PROPOSED')";
    const decParams: Record<string, string> = { $projectId: projectId };

    if (filter.scope) {
      decSql += " AND UPPER(scope)=UPPER($scope)";
      decParams.$scope = filter.scope;
    }
    if (filter.role) {
      // Decisions don't have roles, but filter is no-op
    }

    const decRows = this.db.all<DecisionRow>(decSql, decParams);
    for (const row of decRows) {
      results.push({
        displayId: row.display_id,
        type: "decision",
        status: row.status,
        scope: row.scope,
        title: row.title,
        rationale: row.rationale,
      });
    }

    return results;
  }

  // ── Proposal approval ────────────────────────────────────────────

  /**
   * Apply an approved proposal by transitioning the item to ACTIVE
   * and superseding the previous version if applicable.
   */
  applyApprovedProposal(itemId: string): void {
    this.db.transaction((tx) => {
      // Try guideline first
      const glRow = tx.get<GuidelineRow>(
        "SELECT * FROM knowledge_guidelines WHERE id=$id",
        { $id: itemId },
      );
      if (glRow) {
        this.activateGuideline(tx, glRow);
        return;
      }

      // Try decision
      const decRow = tx.get<DecisionRow>(
        "SELECT * FROM knowledge_decisions WHERE id=$id",
        { $id: itemId },
      );
      if (decRow) {
        this.activateDecision(tx, decRow);
        return;
      }

      throw new Error(`Knowledge item "${itemId}" not found.`);
    });
  }

  // ── Status transitions ───────────────────────────────────────────

  /**
   * Update the status of a knowledge item with transition validation.
   */
  updateStatus(itemId: string, newStatus: GuidelineStatus | DecisionStatus): void {
    this.db.transaction((tx) => {
      // Try guideline
      const glRow = tx.get<GuidelineRow>(
        "SELECT * FROM knowledge_guidelines WHERE id=$id",
        { $id: itemId },
      );
      if (glRow) {
        const allowed = GUIDELINE_STATUS_TRANSITIONS[glRow.status as GuidelineStatus];
        if (!allowed || !allowed.includes(newStatus as GuidelineStatus)) {
          throw new Error(
            `Invalid status transition: ${glRow.status} → ${newStatus}. ` +
            `Allowed: ${allowed?.join(", ") ?? "none"}.`,
          );
        }
        tx.run(
          "UPDATE knowledge_guidelines SET status=$status, updated_at=$now WHERE id=$id",
          { $status: newStatus, $now: new Date().toISOString(), $id: itemId },
        );
        appendOutboxEvent(tx, DomainEvent.create({
          type: "KnowledgeStatusChanged",
          aggregateType: "Guideline",
          aggregateId: itemId,
          payload: { guidelineId: itemId, oldStatus: glRow.status, newStatus },
        }));
        return;
      }

      // Try decision
      const decRow = tx.get<DecisionRow>(
        "SELECT * FROM knowledge_decisions WHERE id=$id",
        { $id: itemId },
      );
      if (decRow) {
        const allowed = DECISION_STATUS_TRANSITIONS[decRow.status as DecisionStatus];
        if (!allowed || !allowed.includes(newStatus as DecisionStatus)) {
          throw new Error(
            `Invalid status transition: ${decRow.status} → ${newStatus}. ` +
            `Allowed: ${allowed?.join(", ") ?? "none"}.`,
          );
        }
        tx.run(
          "UPDATE knowledge_decisions SET status=$status, updated_at=$now WHERE id=$id",
          { $status: newStatus, $now: new Date().toISOString(), $id: itemId },
        );
        appendOutboxEvent(tx, DomainEvent.create({
          type: "KnowledgeStatusChanged",
          aggregateType: "Decision",
          aggregateId: itemId,
          payload: { decisionId: itemId, oldStatus: decRow.status, newStatus },
        }));
        return;
      }

      throw new Error(`Knowledge item "${itemId}" not found.`);
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private upsertGuideline(
    tx: DatabaseTx,
    projectId: string,
    parsed: ParsedGuideline,
    filePath: string,
  ): void {
    const now = new Date().toISOString();
    const existing = tx.get<GuidelineRow>(
      "SELECT id, version, content_hash, status FROM knowledge_guidelines WHERE display_id=$displayId AND project_id=$projectId",
      { $displayId: parsed.id, $projectId: projectId },
    );

    if (!existing) {
      // Brand new guideline
      const id = crypto.randomUUID();
      tx.run(
        `INSERT INTO knowledge_guidelines
         (id, project_id, display_id, category, version, priority, status, scope,
          applicable_roles, rationale, provenance, content_hash, superseded_by, content, file_path, created_at, updated_at)
         VALUES ($id, $projectId, $displayId, $category, $version, $priority, $status, $scope,
                 $applicableRoles, $rationale, $provenance, $contentHash, $supersededBy, $content, $filePath, $now, $now)`,
        {
          $id: id,
          $projectId: projectId,
          $displayId: parsed.id,
          $category: parsed.category,
          $version: parsed.version,
          $priority: parsed.priority,
          $status: parsed.status,
          $scope: parsed.scope,
          $applicableRoles: parsed.applicableRoles.join(","),
          $rationale: parsed.rationale,
          $provenance: parsed.provenance,
          $contentHash: parsed.contentHash,
          $supersededBy: parsed.supersededBy,
          $content: parsed.content,
          $filePath: filePath,
          $now: now,
        },
      );
      appendOutboxEvent(tx, DomainEvent.create({
        type: "GuidelineIndexed",
        aggregateType: "Guideline",
        aggregateId: id,
        payload: { guidelineId: id, displayId: parsed.id, version: parsed.version },
      }));
      return;
    }

    // Existing guideline with same display ID – check for changes
    if (existing.content_hash !== parsed.contentHash) {
      // Content changed externally → PENDING_EXTERNAL_CHANGE (not automatically active)
      const newId = crypto.randomUUID();
      tx.run(
        `INSERT INTO knowledge_guidelines
         (id, project_id, display_id, category, version, priority, status, scope,
          applicable_roles, rationale, provenance, content_hash, superseded_by, content, file_path, created_at, updated_at)
         VALUES ($id, $projectId, $displayId, $category, $version, $priority, $status, $scope,
                 $applicableRoles, $rationale, $provenance, $contentHash, $supersededBy, $content, $filePath, $now, $now)`,
        {
          $id: newId,
          $projectId: projectId,
          $displayId: parsed.id,
          $category: parsed.category,
          $version: parsed.version,
          $priority: parsed.priority,
          $status: parsed.status === "SUPERSEDED" ? "SUPERSEDED" : "PENDING_EXTERNAL_CHANGE",
          $scope: parsed.scope,
          $applicableRoles: parsed.applicableRoles.join(","),
          $rationale: parsed.rationale,
          $provenance: parsed.provenance,
          $contentHash: parsed.contentHash,
          $supersededBy: parsed.supersededBy,
          $content: parsed.content,
          $filePath: filePath,
          $now: now,
        },
      );
      appendOutboxEvent(tx, DomainEvent.create({
        type: "ExternalGuidelineChangeDetected",
        aggregateType: "Guideline",
        aggregateId: newId,
        payload: { guidelineId: newId, displayId: parsed.id, version: parsed.version, oldHash: existing.content_hash, newHash: parsed.contentHash },
      }));
    }
    // If content hash is the same, no update needed
  }

  private upsertDecision(
    tx: DatabaseTx,
    projectId: string,
    parsed: ParsedDecision,
    filePath: string,
  ): void {
    const now = new Date().toISOString();
    const existing = tx.get<DecisionRow>(
      "SELECT id FROM knowledge_decisions WHERE display_id=$displayId AND project_id=$projectId",
      { $displayId: parsed.id, $projectId: projectId },
    );

    if (existing) {
      // Update existing decision
      tx.run(
        `UPDATE knowledge_decisions
         SET status=$status, scope=$scope, title=$title, rationale=$rationale,
             related_guideline=$relatedGuideline, content=$content, file_path=$filePath, updated_at=$now
         WHERE id=$id`,
        {
          $status: parsed.status,
          $scope: parsed.scope,
          $title: parsed.title,
          $rationale: parsed.rationale,
          $relatedGuideline: parsed.relatedGuideline,
          $content: parsed.content,
          $filePath: filePath,
          $now: now,
          $id: existing.id,
        },
      );
      appendOutboxEvent(tx, DomainEvent.create({
        type: "DecisionUpdated",
        aggregateType: "Decision",
        aggregateId: existing.id,
        payload: { decisionId: existing.id, displayId: parsed.id },
      }));
      return;
    }

    // Brand new decision
    const id = crypto.randomUUID();
    tx.run(
      `INSERT INTO knowledge_decisions
       (id, project_id, display_id, status, scope, title, rationale, related_guideline, content, file_path, created_at, updated_at)
       VALUES ($id, $projectId, $displayId, $status, $scope, $title, $rationale, $relatedGuideline, $content, $filePath, $now, $now)`,
      {
        $id: id,
        $projectId: projectId,
        $displayId: parsed.id,
        $status: parsed.status,
        $scope: parsed.scope,
        $title: parsed.title,
        $rationale: parsed.rationale,
        $relatedGuideline: parsed.relatedGuideline,
        $content: parsed.content,
        $filePath: filePath,
        $now: now,
      },
    );
    appendOutboxEvent(tx, DomainEvent.create({
      type: "DecisionIndexed",
      aggregateType: "Decision",
      aggregateId: id,
      payload: { decisionId: id, displayId: parsed.id },
    }));
  }

  private activateGuideline(tx: DatabaseTx, row: GuidelineRow): void {
    const now = new Date().toISOString();
    const allowed = GUIDELINE_STATUS_TRANSITIONS[row.status as GuidelineStatus];
    if (!allowed || !allowed.includes("ACTIVE")) {
      throw new Error(
        `Cannot transition guideline "${row.display_id}" from ${row.status} to ACTIVE.`,
      );
    }

    // Set this version to ACTIVE
    tx.run(
      "UPDATE knowledge_guidelines SET status='ACTIVE', updated_at=$now WHERE id=$id",
      { $now: now, $id: row.id },
    );

    // Supersede previous versions of the same guideline
    tx.run(
      `UPDATE knowledge_guidelines SET status='SUPERSEDED', superseded_by=$supersededBy, updated_at=$now
       WHERE display_id=$displayId AND project_id=$projectId AND id != $id AND status='ACTIVE'`,
      {
        $supersededBy: row.display_id,
        $now: now,
        $displayId: row.display_id,
        $projectId: row.project_id,
        $id: row.id,
      },
    );

    appendOutboxEvent(tx, DomainEvent.create({
      type: "GuidelineActivated",
      aggregateType: "Guideline",
      aggregateId: row.id,
      payload: { guidelineId: row.id, displayId: row.display_id, version: row.version },
    }));
  }

  private activateDecision(tx: DatabaseTx, row: DecisionRow): void {
    const now = new Date().toISOString();
    const allowed = DECISION_STATUS_TRANSITIONS[row.status as DecisionStatus];
    if (!allowed || !allowed.includes("ACCEPTED")) {
      throw new Error(
        `Cannot transition decision "${row.display_id}" from ${row.status} to ACCEPTED.`,
      );
    }

    tx.run(
      "UPDATE knowledge_decisions SET status='ACCEPTED', updated_at=$now WHERE id=$id",
      { $now: now, $id: row.id },
    );

    appendOutboxEvent(tx, DomainEvent.create({
      type: "DecisionAccepted",
      aggregateType: "Decision",
      aggregateId: row.id,
      payload: { decisionId: row.id, displayId: row.display_id },
    }));
  }
}

// ── Internal row types ───────────────────────────────────────────────

interface GuidelineRow {
  id: string;
  project_id: string;
  display_id: string;
  category: string;
  version: number;
  priority: string;
  status: string;
  scope: string;
  applicable_roles: string;
  rationale: string;
  provenance: string;
  content_hash: string;
  superseded_by: string | null;
  content: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  project_id: string;
  display_id: string;
  status: string;
  scope: string;
  title: string;
  rationale: string;
  related_guideline: string | null;
  content: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}

// ── File reading helpers ─────────────────────────────────────────────

interface MarkdownFile {
  relativePath: string;
  content: string;
}

async function readMarkdownFiles(dir: string): Promise<MarkdownFile[]> {
  try {
    const entries = await readdir(dir);
    const files: MarkdownFile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = join(dir, entry);
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      const content = await readFile(fullPath, "utf8");
      files.push({ relativePath: entry, content });
    }
    return files;
  } catch {
    // Directory doesn't exist yet – return empty
    return [];
  }
}
