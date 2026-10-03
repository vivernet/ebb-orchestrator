/**
 * Сравнивает манифесты контекста и сообщает о добавленных, изменённых и удалённых элементах.
 * Результат является диагностикой и не определяет возможность возобновления Run.
 */

import type { ContextManifest, ContextDelta as ContextDeltaResult } from "./context-types.js";

/**
 * Сравнивает манифесты контекста для диагностики изменений.
 * Этот класс не принимает решений о безопасности возобновления Run.
 */
export class ContextDelta {
  /**
   * Сравнивает old and current manifests to compute delta.
   * Сообщает о which items were added, updated, or removed.
   */
  compare(
    oldManifest: ContextManifest,
    currentManifest: ContextManifest,
  ): ContextDeltaResult {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // Сравнивает guideline IDs
    this.compareIdArrays(oldManifest.guidelineIds, currentManifest.guidelineIds, added, removed);

    // Сравнивает decision IDs
    this.compareIdArrays(oldManifest.decisionIds, currentManifest.decisionIds, added, removed);

    // Сравнивает finding IDs
    this.compareIdArrays(oldManifest.findingIds, currentManifest.findingIds, added, removed);

    // Сравнивает defect IDs
    this.compareIdArrays(oldManifest.defectIds, currentManifest.defectIds, added, removed);

    // Detect задача Contract версия change
    if (oldManifest.taskContractVersion !== currentManifest.taskContractVersion) {
      updated.push(currentManifest.taskId);
    }

    return { added, updated, removed };
  }

  /**
   * Сравнивает two ID arrays and populate added/removed lists.
   */
  private compareIdArrays(
    oldIds: string[],
    newIds: string[],
    added: string[],
    removed: string[],
  ): void {
    const oldSet = new Set(oldIds);
    const newSet = new Set(newIds);

    for (const id of newIds) {
      if (!oldSet.has(id)) {
        added.push(id);
      }
    }

    for (const id of oldIds) {
      if (!newSet.has(id)) {
        removed.push(id);
      }
    }
  }
}
