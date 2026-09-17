/**
 * Fake agent runtime for testing.
 * Never sleeps or uses the network.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";

interface ScriptedOutcome {
  outcome: RunOutcome;
  consumed: boolean;
}

/**
 * A fake runtime that supports scripted outcomes for testing.
 */
export class FakeAgentRuntime implements AgentRuntime {
  private readonly scripts: Map<string, ScriptedOutcome[]> = new Map();
  private readonly pendingRuns: Set<string> = new Set();
  readonly resumeCalls: Array<{ runId: string; options: { sessionId: string; attempt: number } }> = [];

  /**
   * Script an outcome for a specific role.
   */
  script(role: string, outcomes: RunOutcome[]): void {
    const scripted: ScriptedOutcome[] = outcomes.map((o) => ({
      outcome: o,
      consumed: false,
    }));
    this.scripts.set(role, scripted);
  }

  /**
   * Start a new run.
   */
  async startRun(_run: AgentRun): Promise<void> {
    // Record run started
  }

  /**
   * Resume a run.
   */
  async resumeRun(
    runId: string,
    options: { sessionId: string; attempt: number },
  ): Promise<void> {
    this.resumeCalls.push({ runId, options });
  }

  /**
   * Cancel a run.
   */
  async cancelRun(_runId: string): Promise<void> {
    // Record cancelled
  }

  /**
   * Inspect a run.
   */
  async inspectRun(_runId: string): Promise<AgentRun> {
    throw new Error("Inspect not implemented");
  }

  /**
   * Collect result from a run using scripted outcomes.
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
   * Collect usage from a run.
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
   * Health check.
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }
}
