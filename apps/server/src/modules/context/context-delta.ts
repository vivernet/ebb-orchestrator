/**
 * Контекст Delta for Orchestrator Hermes.
 * Сравнивает old manifest with current knowledge state.
 * Сообщает о NEW|UPDATED|REMOVED items.
 * Определяет if resume is safe or requires fresh session.
 */

import type { ContextManifest, ContextDelta as ContextDeltaResult } from "./context-types.js";

/** Значимые fields that make resume unsafe when changed */
const MATERIAL_FIELDS = ["taskContractVersion", "taskId", "role"] as const;

/** Возобновление safety check result */
export interface ResumeSafetyResult {
  safe: boolean;
  reason?: "RESUME_NOT_SAFE";
  details?: string;
}

/**
 * Контекст Delta — compares manifests and determines resume safety.
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
   * Determine если resuming Объект сессия является безопасный указанного old и текущий manifests.
   * возвращает RESUME_NOT_SAFE когда material contract changes являются detected.
   */
  isResumeSafe(
    oldManifest: ContextManifest,
    currentManifest: ContextManifest,
  ): ResumeSafetyResult {
    // Проверяет material field changes
    for (const field of MATERIAL_FIELDS) {
      const oldVal = oldManifest[field];
      const newVal = currentManifest[field];

      if (oldVal !== newVal) {
        return {
          safe: false,
          reason: "RESUME_NOT_SAFE",
          details: `Material field changed: ${field}`,
        };
      }
    }

    // Non-material changes (guidelines, findings, etc.) безопасны to resume
    return { safe: true };
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
