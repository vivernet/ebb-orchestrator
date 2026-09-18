/**
 * Workflow registry – manages workflow templates by name.
 */

import type { WorkflowTemplate } from "./workflow-types.js";

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class WorkflowRegistry {
  private readonly templates = new Map<string, WorkflowTemplate>();

  /**
   * Register a workflow template. Overwrites if the name already exists.
   */
  register(template: WorkflowTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Look up a template by name. Returns undefined if not found.
   */
  get(name: string): WorkflowTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Check whether a template with the given name exists.
   */
  has(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * List all registered template names.
   */
  list(): string[] {
    return [...this.templates.keys()];
  }
}
