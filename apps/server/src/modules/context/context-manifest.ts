/**
 * Manifest Builder for Orchestrator Hermes.
 * Persists manifest IDs and versions, NOT secrets.
 */

import type { ContextManifest, Priority } from './context-types.js';

/**
 * Builds ContextManifest for tracking what went into a context package.
 */
export class ManifestBuilder {
  /**
   * Build a context manifest.
   * Only persists IDs and versions, NOT secrets.
   */
  build(input: {
    runId?: string;
    taskId?: string;
    role?: 'developer' | 'reviewer' | 'qa' | 'integration' | 'architect';
    taskContractVersion: string;
    guidelineIds?: string[];
    decisionIds?: string[];
    findingIds?: string[];
    defectIds?: string[];
    contextBuilderVersion?: string;
    initialTokenSize?: number;
  }): ContextManifest {
    const result: Partial<ContextManifest> = {
      taskContractVersion: input.taskContractVersion,
      guidelineIds: input.guidelineIds ?? [],
      decisionIds: input.decisionIds ?? [],
      findingIds: input.findingIds ?? [],
      defectIds: input.defectIds ?? [],
      contextBuilderVersion: input.contextBuilderVersion ?? '1.0.0',
      createdAt: new Date().toISOString(),
    };

    if (input.runId) {
      result.runId = input.runId;
    }
    if (input.taskId) {
      result.taskId = input.taskId;
    }
    if (input.role) {
      result.role = input.role;
    }
    if (input.initialTokenSize !== undefined) {
      result.initialTokenSize = input.initialTokenSize;
    }

    return result as ContextManifest;
  }

  /**
   * Build manifest for a developer context package.
   */
  buildForDeveloper(input: {
    runId: string;
    taskId: string;
    taskContractVersion: string;
    guidelineIds?: string[];
    decisionIds?: string[];
    findingIds?: string[];
    defectIds?: string[];
    contextBuilderVersion?: string;
    initialTokenSize?: number;
  }): ContextManifest {
    const result: Partial<ContextManifest> = {
      runId: input.runId,
      taskId: input.taskId,
      role: 'developer',
      taskContractVersion: input.taskContractVersion,
      guidelineIds: input.guidelineIds ?? [],
      decisionIds: input.decisionIds ?? [],
      findingIds: input.findingIds ?? [],
      defectIds: input.defectIds ?? [],
      contextBuilderVersion: input.contextBuilderVersion ?? '1.0.0',
      createdAt: new Date().toISOString(),
    };

    if (input.initialTokenSize !== undefined) {
      result.initialTokenSize = input.initialTokenSize;
    }

    return result as ContextManifest;
  }

  /**
   * Build manifest for a reviewer context package.
   */
  buildForReviewer(input: {
    runId: string;
    taskId: string;
    taskContractVersion: string;
    guidelineIds?: string[];
    decisionIds?: string[];
    findingIds?: string[];
    contextBuilderVersion?: string;
    initialTokenSize?: number;
  }): ContextManifest {
    const result: Partial<ContextManifest> = {
      runId: input.runId,
      taskId: input.taskId,
      role: 'reviewer',
      taskContractVersion: input.taskContractVersion,
      guidelineIds: input.guidelineIds ?? [],
      decisionIds: input.decisionIds ?? [],
      findingIds: input.findingIds ?? [],
      contextBuilderVersion: input.contextBuilderVersion ?? '1.0.0',
      createdAt: new Date().toISOString(),
    };

    if (input.initialTokenSize !== undefined) {
      result.initialTokenSize = input.initialTokenSize;
    }

    return result as ContextManifest;
  }

  /**
   * Build manifest for a QA context package.
   */
  buildForQA(input: {
    runId: string;
    taskId: string;
    taskContractVersion: string;
    findingIds?: string[];
    defectIds?: string[];
    contextBuilderVersion?: string;
    initialTokenSize?: number;
  }): ContextManifest {
    const result: Partial<ContextManifest> = {
      runId: input.runId,
      taskId: input.taskId,
      role: 'qa',
      taskContractVersion: input.taskContractVersion,
      findingIds: input.findingIds ?? [],
      defectIds: input.defectIds ?? [],
      contextBuilderVersion: input.contextBuilderVersion ?? '1.0.0',
      createdAt: new Date().toISOString(),
    };

    if (input.initialTokenSize !== undefined) {
      result.initialTokenSize = input.initialTokenSize;
    }

    return result as ContextManifest;
  }
}

export const manifestBuilder = new ManifestBuilder();
