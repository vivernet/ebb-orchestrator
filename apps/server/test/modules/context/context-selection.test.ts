import { describe, expect, it } from "vitest";
import { ContextSelector } from "../../../src/modules/context/context-selector.js";
import { ContextBudget } from "../../../src/modules/context/context-budget.js";
import { ContextDelta } from "../../../src/modules/context/context-delta.js";
import type {
  Guideline,
  Decision,
  Finding,
  Defect,
  Priority,
} from "../../../src/modules/context/context-types.js";

// ─── Test fixtures ─────────────────────────────────────────────────────────

/** Guideline matching the 'provider' area and 'developer' role */
const providerArchGuideline: Guideline = {
  id: "GL-ARCH-001",
  category: "ARCH",
  status: "active",
  text: "All provider services must expose a health endpoint",
  priority: "p0",
  scope: "area",
  applicableRoles: ["developer"],
};

/** Guideline for database scope — should NOT be selected for provider Task */
const databaseGuideline: Guideline = {
  id: "GL-DB-001",
  category: "DB",
  status: "active",
  text: "All tables must have explicit primary keys",
  priority: "p1",
  scope: "project",
  applicableRoles: ["developer"],
};

/** Guideline for general developer role — should be included as P1 (cross-cutting) */
const generalDevGuideline: Guideline = {
  id: "GL-DEV-001",
  category: "DEV",
  status: "active",
  text: "Write meaningful commit messages",
  priority: "p1",
  scope: "project",
  applicableRoles: ["developer"],
};

/** Guideline with no applicable role — should be excluded */
const irrelevantRoleGuideline: Guideline = {
  id: "GL-OPS-001",
  category: "OPS",
  status: "active",
  text: "Monitor production latency",
  priority: "p1",
  scope: "area",
  applicableRoles: ["devops"],
};

/** Accepted decision at EPIC scope — should be included */
const acceptedEpicDecision: Decision = {
  id: "DEC-001",
  status: "accepted",
  text: "Use REST API for provider endpoints",
  scope: "EPIC",
  rationale: "Standard API convention",
};

/** Superseded decision — should be excluded */
const supersededDecision: Decision = {
  id: "DEC-002",
  status: "superseded",
  text: "Use SOAP for provider endpoints",
  scope: "PROJECT",
  rationale: "Superseded by REST decision",
};

/** Active open finding — should be included */
const openFinding: Finding = {
  id: "FIND-001",
  status: "open",
  title: "Missing null check in provider handler",
  severity: "high",
};

/** Resolved finding — should be excluded */
const resolvedFinding: Finding = {
  id: "FIND-002",
  status: "resolved",
  title: "Already fixed provider bug",
  severity: "low",
};

/** Open defect — should be included */
const openDefect: Defect = {
  id: "DEF-001",
  status: "open",
  title: "Provider returns 500 on timeout",
};

/** Resolved defect — should be excluded */
const resolvedDefect: Defect = {
  id: "DEF-002",
  status: "resolved",
  title: "Old provider bug",
};

// ─── ContextSelector tests ─────────────────────────────────────────────────

describe("ContextSelector - Structural Selection", () => {
  const selector = new ContextSelector();

  describe("selectForTask - guideline filtering", () => {
    it("includes provider/architecture guideline for provider-area Task", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [providerArchGuideline, databaseGuideline],
        decisions: [],
        findings: [],
        defects: [],
      });
      const guidelineIds = result.guidelines.map((g) => g.id);
      expect(guidelineIds).toContain("GL-ARCH-001");
    });

    it("excludes database guideline for provider Task", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [providerArchGuideline, databaseGuideline],
        decisions: [],
        findings: [],
        defects: [],
      });
      const guidelineIds = result.guidelines.map((g) => g.id);
      expect(guidelineIds).not.toContain("GL-DB-001");
    });

    it("excludes guideline with non-matching role", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [providerArchGuideline, irrelevantRoleGuideline],
        decisions: [],
        findings: [],
        defects: [],
      });
      const guidelineIds = result.guidelines.map((g) => g.id);
      expect(guidelineIds).not.toContain("GL-OPS-001");
    });

    it("includes project-scope guideline for any task area", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [generalDevGuideline],
        decisions: [],
        findings: [],
        defects: [],
      });
      const guidelineIds = result.guidelines.map((g) => g.id);
      expect(guidelineIds).toContain("GL-DEV-001");
    });
  });

  describe("selectForTask - decision filtering", () => {
    it("includes accepted Epic decision", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [acceptedEpicDecision],
        findings: [],
        defects: [],
      });
      const decisionIds = result.decisions.map((d) => d.id);
      expect(decisionIds).toContain("DEC-001");
    });

    it("excludes superseded decision", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [acceptedEpicDecision, supersededDecision],
        findings: [],
        defects: [],
      });
      const decisionIds = result.decisions.map((d) => d.id);
      expect(decisionIds).not.toContain("DEC-002");
    });
  });

  describe("selectForTask - finding/defect filtering", () => {
    it("includes open finding", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [],
        findings: [openFinding, resolvedFinding],
        defects: [],
      });
      const findingIds = result.findings.map((f) => f.id);
      expect(findingIds).toContain("FIND-001");
    });

    it("excludes resolved finding", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [],
        findings: [openFinding, resolvedFinding],
        defects: [],
      });
      const findingIds = result.findings.map((f) => f.id);
      expect(findingIds).not.toContain("FIND-002");
    });

    it("includes open defect", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [],
        findings: [],
        defects: [openDefect, resolvedDefect],
      });
      const defectIds = result.defects.map((d) => d.id);
      expect(defectIds).toContain("DEF-001");
    });

    it("excludes resolved defect", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [],
        decisions: [],
        findings: [],
        defects: [openDefect, resolvedDefect],
      });
      const defectIds = result.defects.map((d) => d.id);
      expect(defectIds).not.toContain("DEF-002");
    });
  });

  describe("selectForTask - priority assignment", () => {
    it("assigns P0 to required guidelines for the task", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [providerArchGuideline],
        decisions: [acceptedEpicDecision],
        findings: [openFinding],
        defects: [],
      });
      // P0 guideline should have priority p0
      const gl = result.guidelines.find((g) => g.id === "GL-ARCH-001");
      expect(gl?.priority).toBe("p0");
    });

    it("assigns P1 to high-priority items", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [generalDevGuideline],
        decisions: [],
        findings: [],
        defects: [],
      });
      const gl = result.guidelines.find((g) => g.id === "GL-DEV-001");
      expect(gl?.priority).toBe("p1");
    });
  });

  describe("selectForTask - full provider task scenario", () => {
    it("includes matching provider/arch guideline and Epic decision, excludes unrelated items", () => {
      const result = selector.selectForTask({
        taskArea: "provider",
        taskPath: "src/services/provider",
        role: "developer",
        guidelines: [providerArchGuideline, databaseGuideline, generalDevGuideline, irrelevantRoleGuideline],
        decisions: [acceptedEpicDecision, supersededDecision],
        findings: [openFinding, resolvedFinding],
        defects: [openDefect, resolvedDefect],
      });

      expect(result.guidelines.map((g) => g.id)).toEqual(
        expect.arrayContaining(["GL-ARCH-001", "GL-DEV-001"]),
      );
      expect(result.guidelines.map((g) => g.id)).not.toContain("GL-DB-001");
      expect(result.guidelines.map((g) => g.id)).not.toContain("GL-OPS-001");
      expect(result.decisions.map((d) => d.id)).toEqual(["DEC-001"]);
      expect(result.findings.map((f) => f.id)).toEqual(["FIND-001"]);
      expect(result.defects.map((d) => d.id)).toEqual(["DEF-001"]);
    });
  });
});

// ─── ContextBudget tests ───────────────────────────────────────────────────

describe("ContextBudget - Over-budget Pruning", () => {
  const budget = new ContextBudget();

  const makeGuideline = (id: string, priority: Priority): Guideline => ({
    id,
    category: "TEST",
    status: "active",
    text: `Guideline ${id}`,
    priority,
    scope: "project",
  });

  describe("pruneByBudget", () => {
    it("returns all items when within budget", () => {
      const items = [
        makeGuideline("GL-P0", "p0"),
        makeGuideline("GL-P1", "p1"),
        makeGuideline("GL-P2", "p2"),
        makeGuideline("GL-P3", "p3"),
      ];
      const result = budget.pruneByBudget(items, 50000);
      expect(result).toHaveLength(4);
    });

    it("removes P3 items first under budget pressure", () => {
      const items = [
        makeGuideline("GL-P0", "p0"),
        makeGuideline("GL-P1", "p1"),
        makeGuideline("GL-P2", "p2"),
        makeGuideline("GL-P3", "p3"),
      ];
      const result = budget.pruneByBudget(items, 500);
      const ids = result.map((g) => g.id);
      expect(ids).toContain("GL-P0");
      expect(ids).toContain("GL-P1");
      expect(ids).toContain("GL-P2");
      expect(ids).not.toContain("GL-P3");
    });

    it("compacts/removes P2 items under severe budget pressure", () => {
      const items = [
        makeGuideline("GL-P0", "p0"),
        makeGuideline("GL-P1", "p1"),
        makeGuideline("GL-P2-1", "p2"),
        makeGuideline("GL-P2-2", "p2"),
        makeGuideline("GL-P3", "p3"),
      ];
      const result = budget.pruneByBudget(items, 200);
      const ids = result.map((g) => g.id);
      expect(ids).toContain("GL-P0");
      expect(ids).toContain("GL-P1");
      // P2 items may be removed/compacted under severe pressure
      expect(ids).not.toContain("GL-P3");
    });

    it("never removes P0 items regardless of budget", () => {
      const items = [
        makeGuideline("GL-P0-1", "p0"),
        makeGuideline("GL-P0-2", "p0"),
        makeGuideline("GL-P1", "p1"),
        makeGuideline("GL-P3", "p3"),
      ];
      const result = budget.pruneByBudget(items, 1);
      const ids = result.map((g) => g.id);
      expect(ids).toContain("GL-P0-1");
      expect(ids).toContain("GL-P0-2");
    });

    it("keeps P0 and P1 when P2/P3 pruned", () => {
      const items = [
        makeGuideline("GL-P0", "p0"),
        makeGuideline("GL-P1", "p1"),
        makeGuideline("GL-P2", "p2"),
        makeGuideline("GL-P3", "p3"),
      ];
      const result = budget.pruneByBudget(items, 200);
      const ids = result.map((g) => g.id);
      expect(ids).toContain("GL-P0");
      expect(ids).toContain("GL-P1");
    });
  });

  describe("estimateTokens", () => {
    it("estimates token count for items", () => {
      const items = [makeGuideline("GL-1", "p0"), makeGuideline("GL-2", "p1")];
      const tokens = budget.estimateTokens(items);
      expect(tokens).toBeGreaterThan(0);
    });
  });
});

// ─── ContextDelta tests ────────────────────────────────────────────────────

describe("ContextDelta - Resume Delta", () => {
  const delta = new ContextDelta();

  describe("compare", () => {
    it("detects NEW items", () => {
      const oldManifest = {
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: ["DEC-001"],
        findingIds: ["FIND-001"],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const currentManifest = {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001", "GL-002"],
        decisionIds: ["DEC-001", "DEC-003"],
        findingIds: ["FIND-001"],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      };

      const result = delta.compare(oldManifest, currentManifest);
      expect(result.added).toContain("GL-002");
      expect(result.added).toContain("DEC-003");
      expect(result.updated).toEqual([]);
      expect(result.removed).toEqual([]);
    });

    it("detects REMOVED items", () => {
      const oldManifest = {
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001", "GL-002"],
        decisionIds: ["DEC-001"],
        findingIds: ["FIND-001", "FIND-002"],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const currentManifest = {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: ["FIND-001"],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      };

      const result = delta.compare(oldManifest, currentManifest);
      expect(result.added).toEqual([]);
      expect(result.removed).toContain("GL-002");
      expect(result.removed).toContain("DEC-001");
      expect(result.removed).toContain("FIND-002");
    });

    it("detects UPDATED items when manifest versions change", () => {
      const oldManifest = {
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const currentManifest = {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer" as const,
        taskContractVersion: "2.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      };

      const result = delta.compare(oldManifest, currentManifest);
      expect(result.updated).toContain("TASK-001");
    });
  });

  describe("isResumeSafe", () => {
    it("returns safe when no material changes", () => {
      const result = delta.isResumeSafe({
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      }, {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(result.safe).toBe(true);
    });

    it("returns RESUME_NOT_SAFE when task contract version changed", () => {
      const result = delta.isResumeSafe({
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      }, {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "2.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toBe("RESUME_NOT_SAFE");
    });

    it("returns RESUME_NOT_SAFE when task ID changed", () => {
      const result = delta.isResumeSafe({
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      }, {
        runId: "run-2",
        taskId: "TASK-002",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toBe("RESUME_NOT_SAFE");
    });

    it("returns RESUME_NOT_SAFE when role changed", () => {
      const result = delta.isResumeSafe({
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      }, {
        runId: "run-2",
        taskId: "TASK-001",
        role: "reviewer",
        taskContractVersion: "1.0",
        guidelineIds: [],
        decisionIds: [],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toBe("RESUME_NOT_SAFE");
    });

    it("returns safe when only non-material items changed", () => {
      const result = delta.isResumeSafe({
        runId: "run-1",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001"],
        decisionIds: [],
        findingIds: ["FIND-001"],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-01T00:00:00Z",
      }, {
        runId: "run-2",
        taskId: "TASK-001",
        role: "developer",
        taskContractVersion: "1.0",
        guidelineIds: ["GL-001", "GL-002"],
        decisionIds: ["DEC-001"],
        findingIds: [],
        defectIds: [],
        contextBuilderVersion: "1.0.0",
        createdAt: "2026-01-02T00:00:00Z",
      });
      // Task contract didn't change, just guidelines/findings — safe to resume
      expect(result.safe).toBe(true);
    });
  });
});
