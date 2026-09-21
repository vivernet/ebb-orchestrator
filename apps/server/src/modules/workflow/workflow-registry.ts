/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import type { WorkflowTemplate } from "./workflow-types.js";

/**
 * Определяет workflow-контракт workflow-registry и сохраняет допустимые переходы состояний.
 */
export class WorkflowRegistry {
  private readonly templates = new Map<string, WorkflowTemplate>();

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  register(template: WorkflowTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  get(name: string): WorkflowTemplate | undefined {
    return this.templates.get(name);
  }

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  has(name: string): boolean {
    return this.templates.has(name);
  }

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  list(): string[] {
    return [...this.templates.keys()];
  }
}
