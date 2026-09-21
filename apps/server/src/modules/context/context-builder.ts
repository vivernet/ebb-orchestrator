/**
 * Контекст Builder для Orchestrator Hermes.
 * Формирует пакеты контекста для разных ролей агентов.
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
   * Формирует пакет контекста Developer.
   * Включает Task Contract, активные findings/defects, metadata workspace,
   * сводку role contract и инструкции вывода.
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
    // Исключает закрытые findings.
    const activeFindings = (input.findings ?? []).filter(
      (f) => f.status !== 'resolved' && f.status !== 'closed'
    );

    // Исключает закрытые defects.
    const activeDefects = (input.defects ?? []).filter(
      (d) => d.status !== 'resolved' && d.status !== 'closed'
    );

    // Сокращает guidelines по бюджету.
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
   * Формирует пакет контекста Reviewer.
   * Включает Task Contract, Git diff, проверки и относящиеся к делу ограничения.
   * Не включает разговор Developer.
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
    // Сокращает guidelines по бюджету.
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
   * Формирует пакет контекста QA.
   * Включает Acceptance Criteria, поведение, окружение и defects для повторной проверки.
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
   * Применяет сокращение бюджета P0-P3 без LLM summarization.
   * Делегирует детерминированное сокращение по приоритету ContextBudget.
   */
  private pruneByBudget<T extends { priority?: Priority }>(
    items: T[],
    budgetLimit?: number
  ): T[] {
    if (budgetLimit === undefined) {
      // Давления бюджета нет — возвращает все элементы.
      return items;
    }

    const contextBudget = new ContextBudget();
    return contextBudget.pruneByBudget(items, budgetLimit);
  }

  /**
   * Оценивает размер элементов упрощённым способом.
   */
  private estimateSize<T>(items: T[]): number {
    // Простая эвристика: 100 token на элемент в качестве baseline.
    return items.length * 100;
  }

  /**
   * Формирует пакет контекста Integration.
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
