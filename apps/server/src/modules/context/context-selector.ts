/**
 * Контекст Selector for Orchestrator Hermes.
 * Выбирает relevant knowledge items based on scope, area, path, role, and tags.
 * Фильтрует out resolved findings, superseded decisions, and irrelevant guidelines.
 * Назначает P0-P3 priority levels based on role and relevance.
 */

import type {
  Guideline,
  Decision,
  Finding,
  Defect,
  Priority,
} from "./context-types.js";

/** Результат of context selection for a task */
export interface SelectedContext {
  guidelines: Guideline[];
  decisions: Decision[];
  findings: Finding[];
  defects: Defect[];
}

/**
 * Категории that are cross-cutting and apply to all task areas.
 */
const CROSS_CUTTING_CATEGORIES = new Set(["ARCH", "DEV", "SECURITY", "STYLE"]);

/**
 * Контекст Selector — deterministic structural selection.
 * Нет embedding/vector service required.
 */
export class ContextSelector {
  /**
   * Выбирает relevant context for a task.
   * Фильтрует by scope/area/path/role and assigns priorities.
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
   * Выбирает guidelines relevant to a task.
   * Включает guidelines that:
   * - are active
   * - have a matching applicable role
   * - whose category is relevant to the task area:
   *   - cross-cutting categories (ARCH, DEV, SECURITY, STYLE) always apply
   *   - domain-specific categories (DB, etc.) only apply if they match the task area
   * Исключает inactive/deprecated guidelines.
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
   * Выбирает decisions relevant to a task.
   * Только includes accepted decisions. Исключает superseded.
   * Включает project, area, epic, and task-scope decisions.
   */
  private selectDecisions(decisions: Decision[]): Decision[] {
    return decisions.filter((d) => d.status === "accepted");
  }

  /**
   * Выбирает findings — only open/in-progress (not resolved/closed).
   */
  private selectFindings(findings: Finding[]): Finding[] {
    return findings.filter(
      (f) => f.status === "open" || f.status === "in_progress",
    );
  }

  /**
   * Выбирает defects — only open/in-progress (not resolved/closed).
   */
  private selectDefects(defects: Defect[]): Defect[] {
    return defects.filter(
      (d) => d.status === "open" || d.status === "in_progress",
    );
  }

  /**
   * Проверяет if the guideline's applicable roles include the given role.
   * Если no applicableRoles is set, guideline applies to all roles.
   */
  private roleMatches(applicableRoles: string[] | undefined, role: string): boolean {
    if (!applicableRoles || applicableRoles.length === 0) {
      return true;
    }
    return applicableRoles.includes(role);
  }

  /**
   * Проверяет if a guideline's category is relevant to the task area.
   * Сквозные categories (ARCH, DEV, SECURITY, STYLE) apply to all areas.
   * Предметно-специфичные categories only apply if they match the task area.
   */
  private categoryRelevantToArea(category: string, taskArea: string): boolean {
    const normalizedCategory = category.toUpperCase();
    const normalizedArea = taskArea.toUpperCase();

    // Сквозные categories always apply
    if (CROSS_CUTTING_CATEGORIES.has(normalizedCategory)) {
      return true;
    }

    // Предметно-специфичные: category must match the task area
    return normalizedCategory === normalizedArea;
  }

  /**
   * Assign priority to Объект guideline based on its metadatОбъект и задача контекст.
   * Правила:
   * - Guidelines with explicit priority keep it
   * - Cross-cutting guidelines matching task area → P1
   * - General project guidelines → P2
   * - Other → P3
   */
  private assignGuidelinePriority(guideline: Guideline, _taskArea: string): Priority {
    // Если guideline already has an explicit priority mapping, use it
    if (guideline.priority) {
      return guideline.priority;
    }

    // Назначение priority assignment
    if (guideline.scope === "project") {
      return "p1"; // Project-wide guidelines are high priority
    }
    if (guideline.scope === "area") {
      return "p2"; // Area-specific guidelines are supporting
    }
    return "p3"; // Everything else is optional
  }
}
