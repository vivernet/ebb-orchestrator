/**
 * Context Selector for Orchestrator Hermes.
 * Selects relevant knowledge items based on scope, area, path, role, and tags.
 * Filters out resolved findings, superseded decisions, and irrelevant guidelines.
 * Assigns P0-P3 priority levels based on role and relevance.
 */

import type {
  Guideline,
  Decision,
  Finding,
  Defect,
  Priority,
} from "./context-types.js";

/** Result of context selection for a task */
export interface SelectedContext {
  guidelines: Guideline[];
  decisions: Decision[];
  findings: Finding[];
  defects: Defect[];
}

/**
 * Categories that are cross-cutting and apply to all task areas.
 */
const CROSS_CUTTING_CATEGORIES = new Set(["ARCH", "DEV", "SECURITY", "STYLE"]);

/**
 * Context Selector — deterministic structural selection.
 * No embedding/vector service required.
 */
export class ContextSelector {
  /**
   * Select relevant context for a task.
   * Filters by scope/area/path/role and assigns priorities.
   */
  selectForTask(input: {
    taskArea: string;
    taskPath: string;
    role: string;
    guidelines: Guideline[];
    decisions: Decision[];
    findings: Finding[];
    defects: Defect[];
  }): SelectedContext {
    const guidelines = this.selectGuidelines(
      input.guidelines,
      input.taskArea,
      input.taskPath,
      input.role,
    );
    const decisions = this.selectDecisions(input.decisions);
    const findings = this.selectFindings(input.findings);
    const defects = this.selectDefects(input.defects);

    return { guidelines, decisions, findings, defects };
  }

  /**
   * Select guidelines relevant to a task.
   * Includes guidelines that:
   * - are active
   * - have a matching applicable role
   * - whose category is relevant to the task area:
   *   - cross-cutting categories (ARCH, DEV, SECURITY, STYLE) always apply
   *   - domain-specific categories (DB, etc.) only apply if they match the task area
   * Excludes inactive/deprecated guidelines.
   */
  private selectGuidelines(
    guidelines: Guideline[],
    taskArea: string,
    _taskPath: string,
    role: string,
  ): Guideline[] {
    return guidelines
      .filter((g) => g.status === "active")
      .filter((g) => this.roleMatches(g.applicableRoles, role))
      .filter((g) => this.categoryRelevantToArea(g.category, taskArea))
      .map((g) => ({
        ...g,
        priority: this.assignGuidelinePriority(g, taskArea),
      }));
  }

  /**
   * Select decisions relevant to a task.
   * Only includes accepted decisions. Excludes superseded.
   * Includes project, area, epic, and task-scope decisions.
   */
  private selectDecisions(decisions: Decision[]): Decision[] {
    return decisions.filter((d) => d.status === "accepted");
  }

  /**
   * Select findings — only open/in-progress (not resolved/closed).
   */
  private selectFindings(findings: Finding[]): Finding[] {
    return findings.filter(
      (f) => f.status === "open" || f.status === "in_progress",
    );
  }

  /**
   * Select defects — only open/in-progress (not resolved/closed).
   */
  private selectDefects(defects: Defect[]): Defect[] {
    return defects.filter(
      (d) => d.status === "open" || d.status === "in_progress",
    );
  }

  /**
   * Check if the guideline's applicable roles include the given role.
   * If no applicableRoles is set, guideline applies to all roles.
   */
  private roleMatches(applicableRoles: string[] | undefined, role: string): boolean {
    if (!applicableRoles || applicableRoles.length === 0) {
      return true;
    }
    return applicableRoles.includes(role);
  }

  /**
   * Check if a guideline's category is relevant to the task area.
   * Cross-cutting categories (ARCH, DEV, SECURITY, STYLE) apply to all areas.
   * Domain-specific categories only apply if they match the task area.
   */
  private categoryRelevantToArea(category: string, taskArea: string): boolean {
    const normalizedCategory = category.toUpperCase();
    const normalizedArea = taskArea.toUpperCase();

    // Cross-cutting categories always apply
    if (CROSS_CUTTING_CATEGORIES.has(normalizedCategory)) {
      return true;
    }

    // Domain-specific: category must match the task area
    return normalizedCategory === normalizedArea;
  }

  /**
   * Assign priority to a guideline based on its metadata and task context.
   * Rules:
   * - Guidelines with explicit priority keep it
   * - Cross-cutting guidelines matching task area → P1
   * - General project guidelines → P2
   * - Other → P3
   */
  private assignGuidelinePriority(guideline: Guideline, _taskArea: string): Priority {
    // If guideline already has an explicit priority mapping, use it
    if (guideline.priority) {
      return guideline.priority;
    }

    // Default priority assignment
    if (guideline.scope === "project") {
      return "p1"; // Project-wide guidelines are high priority
    }
    if (guideline.scope === "area") {
      return "p2"; // Area-specific guidelines are supporting
    }
    return "p3"; // Everything else is optional
  }
}
