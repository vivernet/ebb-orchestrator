/**
 * Имитация agent runtime для тестов.
 * Не выполняет ожидание и не использует сеть.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";

interface ScriptedOutcome {
  outcome: RunOutcome;
  consumed: boolean;
}

/**
 * Имитация runtime с заданными результатами для тестирования.
 */
export class FakeAgentRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  private readonly scripts: Map<string, ScriptedOutcome[]> = new Map();
  private readonly pendingRuns: Set<string> = new Set();
  readonly resumeCalls: Array<{ runId: string; options: { sessionId: string; attempt: number } }> = [];

  /**
 * Задаёт результат для конкретной роли.
   */
  script(role: string, outcomes: RunOutcome[]): void {
    const scripted: ScriptedOutcome[] = outcomes.map((o) => ({
      outcome: o,
      consumed: false,
    }));
    this.scripts.set(role, scripted);
  }

  /**
 * Запускает новый run.
   */
  async startRun(_run: AgentRun): Promise<void> {
    // Записываем начало run.
  }

  /**
 * Возобновляет run.
   */
  async resumeRun(
    runId: string,
    options: { sessionId: string; attempt: number },
  ): Promise<void> {
    this.resumeCalls.push({ runId, options });
  }

  /**
 * Отменяет run.
   */
  async cancelRun(_runId: string): Promise<void> {
    // Записываем отмену.
  }

  /**
 * Проверяет состояние run.
   */
  async inspectRun(_runId: string): Promise<AgentRun> {
    throw new Error("Inspect not implemented");
  }

  /**
 * Получает результат run с учётом заданных результатов.
   */
  async collectResult(_runId: string): Promise<RunOutcome> {
    const roles = Array.from(this.scripts.keys());
    if (roles.length === 0) {
      throw new Error("No scripted outcome available");
    }
    const role = roles[0]!;
    const scripted = this.scripts.get(role)!;
    const available = scripted.find((s) => !s.consumed);
    if (!available) {
      throw new Error("No scripted outcome available");
    }
    available.consumed = true;
    return available.outcome;
  }

  /**
 * Получает usage run.
   */
  async collectUsage(_runId: string): Promise<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    throw new Error("Usage not implemented");
  }

  /**
 * Возвращает результат run.
    */
  async runResult(_runId: string): Promise<RunOutcome> {
    throw new Error("runResult not implemented");
  }

  /**
 * Проверка состояния.
    */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
