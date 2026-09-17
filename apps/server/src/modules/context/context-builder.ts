/**
 * Context Builder for Orchestrator Hermes.
 * Builds context packages for different agent roles.
 */

import type {
  TaskContract,
  Finding,
  Defect,
  Guideline,
  Decision,
  Message,
  WorkspaceMeta,
  Priority,
  DeveloperContextPackage,
  ReviewerContextPackage,
} from './context-types.js';
import { ContextBudget } from './context-budget.js';

/**
 * Builds context packages for agent roles.
 * Implements role separation and budget pruning.
 */
export class ContextBuilder {
  /**
   * Build Developer Context Package.
   * Includes: Task Contract, active findings/defects, workspace metadata,
   * role contract summary, output instructions.
   */
  buildDeveloperPackage(input: {
    taskContract: TaskContract;
    findings?: Finding[];
    defects?: Defect[];
    guidelines?: Guideline[];
    decisions?: Decision[];
    workspaceMeta?: WorkspaceMeta;
    developerSession?: Message[];
    outputInstructions?: string;
    roleContractSummary?: string;
    budgetLimit?: number;
  }): DeveloperContextPackage {
    // Filter out resolved findings
    const activeFindings = (input.findings ?? []).filter(
      (f) => f.status !== 'resolved' && f.status !== 'closed'
    );

    // Filter out resolved defects
    const activeDefects = (input.defects ?? []).filter(
      (d) => d.status !== 'resolved' && d.status !== 'closed'
    );

    // Apply budget pruning to guidelines
    const prunedGuidelines = this.pruneByBudget(
      input.guidelines ?? [],
      input.budgetLimit
    );

    const result: Partial<DeveloperContextPackage> = {
      taskContract: input.taskContract,
      findings: activeFindings,
      defects: activeDefects,
      guidelines: prunedGuidelines,
      decisions: input.decisions ?? [],
    };

    if (input.workspaceMeta) {
      result.workspaceMeta = input.workspaceMeta;
    }
    if (input.developerSession) {
      result.sessionTranscript = input.developerSession;
    }

    return result as DeveloperContextPackage;
  }

  /**
   * Build Reviewer Context Package.
   * Includes: Task Contract, Git diff, checks, relevant constraints.
   * Does NOT include Developer conversation.
   */
  buildReviewerPackage(input: {
    taskContract: TaskContract;
    gitDiff?: string;
    checks?: string[];
    guidelines?: Guideline[];
    decisions?: Decision[];
    findings?: Finding[];
    developerSession?: Message[];
    budgetLimit?: number;
  }): ReviewerContextPackage {
    // Apply budget pruning to guidelines
    const prunedGuidelines = this.pruneByBudget(
      input.guidelines ?? [],
      input.budgetLimit
    );

    const result: Partial<ReviewerContextPackage> = {
      taskContract: input.taskContract,
      checks: input.checks ?? [],
      guidelines: prunedGuidelines,
      decisions: input.decisions ?? [],
      findings: input.findings ?? [],
    };

    if (input.gitDiff) {
      result.gitDiff = input.gitDiff;
    }

    return result as ReviewerContextPackage;
  }

  /**
   * Build QA Context Package.
   * Includes: Acceptance Criteria, behavior, environment, defects to retest.
   */
  buildQAPackage(input: {
    taskContract: TaskContract;
    environment?: string;
    defects?: Defect[];
  }): { taskContract: TaskContract; environment?: string; defects?: Defect[] } {
    const activeDefects = (input.defects ?? []).filter(
      (d) => d.status === 'open' || d.status === 'in_progress'
    );

    const result: Partial<{
      taskContract: TaskContract;
      environment?: string;
      defects?: Defect[];
    }> = {
      taskContract: input.taskContract,
      defects: activeDefects,
    };

    if (input.environment) {
      result.environment = input.environment;
    }

    return result as {
      taskContract: TaskContract;
      environment?: string;
      defects?: Defect[];
    };
  }

  /**
   * Apply P0-P3 budget pruning without LLM summarization.
   * Delegates to ContextBudget for deterministic priority-based pruning.
   */
  private pruneByBudget<T extends { priority?: Priority }>(
    items: T[],
    budgetLimit?: number
  ): T[] {
    if (budgetLimit === undefined) {
      // No budget pressure - return all items
      return items;
    }

    const contextBudget = new ContextBudget();
    return contextBudget.pruneByBudget(items, budgetLimit);
  }

  /**
   * Estimate size of items (simplified).
   */
  private estimateSize<T>(items: T[]): number {
    // Simple heuristic: 100 tokens per item as baseline
    return items.length * 100;
  }

  /**
   * Build Integration Context Package.
   */
  buildIntegrationPackage(input: {
    taskContract: TaskContract;
    gitDiff?: string;
    checks?: string[];
  }): {
    taskContract: TaskContract;
    gitDiff?: string;
    checks?: string[];
  } {
    const result: Partial<{
      taskContract: TaskContract;
      gitDiff?: string;
      checks?: string[];
    }> = {
      taskContract: input.taskContract,
      checks: input.checks ?? [],
    };

    if (input.gitDiff) {
      result.gitDiff = input.gitDiff;
    }

    return result as {
      taskContract: TaskContract;
      gitDiff?: string;
      checks?: string[];
    };
  }
}

export const contextBuilder = new ContextBuilder();
