/**
 * Context Delta for Orchestrator Hermes.
 * Compares old manifest with current knowledge state.
 * Reports NEW|UPDATED|REMOVED items.
 * Determines if resume is safe or requires fresh session.
 */

import type { ContextManifest, ContextDelta as ContextDeltaResult } from "./context-types.js";

/** Material fields that make resume unsafe when changed */
const MATERIAL_FIELDS = ["taskContractVersion", "taskId", "role"] as const;

/** Resume safety check result */
export interface ResumeSafetyResult {
  safe: boolean;
  reason?: "RESUME_NOT_SAFE";
  details?: string;
}

/**
 * Context Delta — compares manifests and determines resume safety.
 */
export class ContextDelta {
  /**
   * Compare old and current manifests to compute delta.
   * Reports which items were added, updated, or removed.
   */
  compare(
    oldManifest: ContextManifest,
    currentManifest: ContextManifest,
  ): ContextDeltaResult {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // Compare guideline IDs
    this.compareIdArrays(oldManifest.guidelineIds, currentManifest.guidelineIds, added, removed);

    // Compare decision IDs
    this.compareIdArrays(oldManifest.decisionIds, currentManifest.decisionIds, added, removed);

    // Compare finding IDs
    this.compareIdArrays(oldManifest.findingIds, currentManifest.findingIds, added, removed);

    // Compare defect IDs
    this.compareIdArrays(oldManifest.defectIds, currentManifest.defectIds, added, removed);

    // Detect task contract version change
    if (oldManifest.taskContractVersion !== currentManifest.taskContractVersion) {
      updated.push(currentManifest.taskId);
    }

    return { added, updated, removed };
  }

  /**
   * Determine if resuming a session is safe given old and current manifests.
   * Returns RESUME_NOT_SAFE when material contract changes are detected.
   */
  isResumeSafe(
    oldManifest: ContextManifest,
    currentManifest: ContextManifest,
  ): ResumeSafetyResult {
    // Check material field changes
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

    // Non-material changes (guidelines, findings, etc.) are safe to resume
    return { safe: true };
  }

  /**
   * Compare two ID arrays and populate added/removed lists.
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
