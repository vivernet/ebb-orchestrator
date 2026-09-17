/**
 * Context Budget for Orchestrator Hermes.
 * Implements deterministic over-budget pruning.
 * Removes P3 first, then P2, never removes P0.
 */

import type { Priority } from "./context-types.js";

/** Token estimate for a single context item */
const TOKENS_PER_ITEM = 100;

/**
 * Context Budget — deterministic pruning when context exceeds budget.
 * No LLM summarization used.
 */
export class ContextBudget {
  /**
   * Prune items by budget pressure.
   * Deterministic ordering: P3 removed first, then P2, P0 never removed.
   *
   * @param items - Items with optional priority
   * @param budgetLimit - Token budget limit. Lower = more aggressive pruning.
   * @returns Pruned items
   */
  pruneByBudget<T extends { priority?: Priority }>(items: T[], budgetLimit: number): T[] {
    // No budget pressure — return all items
    if (budgetLimit >= 10000) {
      return items;
    }

    // P0 items are NEVER pruned
    const p0 = items.filter((item) => item.priority === "p0");

    // P1 items — always included
    const p1 = items.filter((item) => item.priority === "p1");

    // P2 items — compact/remove under severe pressure
    const p2 = items.filter((item) => item.priority === "p2");

    // P3 items — pruned first under any budget pressure
    const p3 = items.filter((item) => item.priority === "p3");

    // Budget pressure levels:
    // < 10000: remove P3
    // < 500: remove P3 + P2 (severe)
    // < 100:  remove P3 + P2, keep only P0 (critical)
    if (budgetLimit < 100) {
      // Critical: only P0 survives
      return p0;
    }

    if (budgetLimit < 500) {
      // Severe: P0 + P1 only
      return [...p0, ...p1];
    }

    // Moderate: P0 + P1 + P2 (P3 removed)
    return [...p0, ...p1, ...p2];
  }

  /**
   * Estimate token count for a set of items.
   * Simplified heuristic: 100 tokens per item.
   */
  estimateTokens<T>(items: T[]): number {
    return items.length * TOKENS_PER_ITEM;
  }
}
