import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { KnowledgeAnalyzer } from "../../../src/modules/knowledge/knowledge-analyzer.js";
import type { GuidelineRecord } from "../../../src/modules/knowledge/knowledge-types.js";

// ── Вспомогательная функция для создания GuidelineRecord ───────────

function makeGuideline(overrides: Partial<GuidelineRecord> & { id: string; displayId: string; projectId: string }): GuidelineRecord {
  return {
    category: "ARCH",
    version: 1,
    priority: "REQUIRED",
    status: "ACTIVE",
    scope: "project",
    applicableRoles: ["developer"],
    rationale: "rationale",
    provenance: "team-decision",
    contentHash: "abc123",
    supersededBy: null,
    content: "Body content",
    filePath: "guidelines/GL-ARCH-014.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Пример markdown правила (полное содержимое файла) ──────────────

const GUIDELINE_MD = `---
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

const GUIDELINE_SAME_TEXT = `---
id: GL-ARCH-015
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

const GUIDELINE_FORMATTING_ONLY = `---
id: GL-ARCH-014
category: ARCH
version: 2
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer,architect
rationale: All API endpoints must use versioned paths.
provenance: team-decision
content_hash: fmt789
superseded_by:
---
# API versioning

All  API   endpoints  must  use  versioned  paths (e.g. /v1/...).
`;

const GUIDELINE_EXTENSION = `---
id: GL-ARCH-014
category: ARCH
version: 2
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer,architect
rationale: All API endpoints must use versioned paths. V2 adds GraphQL support.
provenance: team-decision
content_hash: ext789
superseded_by:
---
# API versioning V2

All API endpoints must use versioned paths. Also supports GraphQL.
`;

const GUIDELINE_CONFLICT = `---
id: GL-ARCH-014
category: ARCH
version: 2
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer,architect
rationale: API endpoints should NOT use versioned paths; use content negotiation instead.
provenance: team-decision
content_hash: con012
superseded_by:
---
# API versioning

API endpoints should NOT use versioned paths. Use content negotiation instead.
`;

const GUIDELINE_DIFFERENT_CATEGORY = `---
id: GL-SEC-001
category: SEC
version: 1
priority: REQUIRED
status: ACTIVE
scope: project
applicable_roles: developer
rationale: All secrets must be encrypted at rest.
provenance: team-decision
content_hash: sec001
superseded_by:
---
# Secrets encryption

All secrets must be encrypted at rest.
`;

// ── Тесты ───────────────────────────────────────────────────────────

describe("KnowledgeAnalyzer", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function makeAnalyzer(): { analyzer: KnowledgeAnalyzer; repoDir: string } {
    dir = "";
    return { analyzer: new KnowledgeAnalyzer(), repoDir: "" };
  }

  describe("candidate selection (narrowing)", () => {
    it("returns NEW when no candidates overlap in category and scope", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({ id: "db-gl-1", displayId: "GL-SEC-001", projectId, category: "SEC", scope: "project" }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_MD };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("NEW");
    });

    it("narrows candidates to same category and overlapping scope", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({ id: "db-gl-1", displayId: "GL-ARCH-014", projectId, category: "ARCH", scope: "project" }),
        makeGuideline({ id: "db-gl-2", displayId: "GL-SEC-001", projectId, category: "SEC", scope: "project" }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_MD };
      const result = analyzer.classify(proposal, existing);
// Должен остаться только GL-ARCH-014 (та же категория), но не GL-SEC-001.
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.displayId).toBe("GL-ARCH-014");
    });
  });

  describe("DUPLICATE classification", () => {
    it("classifies exact normalized text duplicate as DUPLICATE", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "# API versioning\n\nAll API endpoints must use versioned paths (e.g. /v1/...).",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_SAME_TEXT };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("DUPLICATE");
      expect(result.matchedCandidateId).toBe("db-gl-1");
    });

    it("classifies DUPLICATE without requiring AI analysis", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "All API endpoints must use versioned paths.",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_SAME_TEXT };
      const result = analyzer.classify(proposal, existing);
// DUPLICATE должен быть детерминированным — без флага aiAnalysisRequired.
      expect(result.classification).toBe("DUPLICATE");
      expect(result.requiresAiAnalysis).toBe(false);
    });
  });

  describe("NEW classification", () => {
    it("classifies as NEW when no candidate has overlapping content", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "All API endpoints must use versioned paths.",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_DIFFERENT_CATEGORY };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("NEW");
      expect(result.requiresAiAnalysis).toBe(false);
    });
  });

  describe("editorial (formatting/whitespace only)", () => {
    it("classifies formatting-only changes as EDITORIAL deterministically", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "# API versioning\n\nAll API endpoints must use versioned paths (e.g. /v1/...).",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_FORMATTING_ONLY };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("EDITORIAL");
      expect(result.requiresAiAnalysis).toBe(false);
      expect(result.matchedCandidateId).toBe("db-gl-1");
    });
  });

  describe("scope overlap detection", () => {
    it("matches candidates with same scope", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({ id: "db-gl-1", displayId: "GL-ARCH-014", projectId, category: "ARCH", scope: "project" }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_MD };
      const result = analyzer.classify(proposal, existing);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.displayId).toBe("GL-ARCH-014");
    });

    it("matches candidates when scope is superset (project contains area)", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({ id: "db-gl-1", displayId: "GL-ARCH-020", projectId, category: "ARCH", scope: "area" }),
      ];
// GL-ARCH-014 (область проект) должен совпасть с существующим правилом области.
      const proposal = { projectId, markdown: GUIDELINE_MD };
      const result = analyzer.classify(proposal, existing);
      expect(result.candidates).toHaveLength(1);
    });

    it("excludes candidates with non-overlapping scope", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({ id: "db-gl-1", displayId: "GL-ARCH-020", projectId, category: "ARCH", scope: "area" }),
      ];
// У GL-SEC-001 другая категория, поэтому кандидатов нет.
      const proposal = { projectId, markdown: GUIDELINE_DIFFERENT_CATEGORY };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("NEW");
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe("CLARIFICATION / EXTENSION / CONFLICT / REPLACEMENT (requires AI)", () => {
    it("marks EXTENSION as requiring AI analysis", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "# API versioning\n\nAll API endpoints must use versioned paths.",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_EXTENSION };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("EXTENSION");
      expect(result.requiresAiAnalysis).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.displayId).toBe("GL-ARCH-014");
    });

    it("marks CONFLICT as requiring AI analysis", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "# API versioning\n\nAll API endpoints must use versioned paths.",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_CONFLICT };
      const result = analyzer.classify(proposal, existing);
      expect(result.classification).toBe("CONFLICT");
      expect(result.requiresAiAnalysis).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns NEW when no candidates exist", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const result = analyzer.classify({ projectId, markdown: GUIDELINE_MD }, []);
      expect(result.classification).toBe("NEW");
      expect(result.candidates).toHaveLength(0);
      expect(result.requiresAiAnalysis).toBe(false);
    });

    it("handles multiple candidates with same category correctly", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "API versioning with REST.",
        }),
        makeGuideline({
          id: "db-gl-2",
          displayId: "GL-ARCH-015",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "GraphQL schema design.",
        }),
      ];
      const proposal = { projectId, markdown: GUIDELINE_MD };
      const result = analyzer.classify(proposal, existing);
// Оба имеют категорию ARCH и область project → оба являются кандидатами.
      expect(result.candidates).toHaveLength(2);
    });

    it("whitespace normalization collapses multiple spaces and tabs", () => {
      const { analyzer } = makeAnalyzer();
      const projectId = randomUUID();
      const existing: GuidelineRecord[] = [
        makeGuideline({
          id: "db-gl-1",
          displayId: "GL-ARCH-014",
          projectId,
          category: "ARCH",
          scope: "project",
          content: "All API endpoints must use versioned paths.",
        }),
      ];
// Создаём proposal с tab и несколькими пробелами, нормализующимися в одинаковый текст.
      const tabMd = GUIDELINE_MD.replace(
        "All API endpoints must use versioned paths (e.g. /v1/...).",
        "All\tAPI  endpoints   must\t\tuse  versioned  paths  (e.g.  /v1/...).",
      );
      const result = analyzer.classify({ projectId, markdown: tabMd }, existing);
      expect(result.classification).toBe("DUPLICATE");
    });
  });
});
