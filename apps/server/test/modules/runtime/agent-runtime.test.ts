/**
 * Общий контракт AgentRuntime (plan-24, Task 3).
 *
 * Проверяет, что существующий Hermes-адаптер сохранён и что новый
 * ProviderAgentRuntime реализует тот же интерфейс (типизированно и
 * структурно).
 */

import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentRuntimeRun } from "../../../src/modules/runtime/agent-runtime.js";
import { ProviderAgentRuntime } from "../../../src/modules/runtime/providers/provider-agent-runtime.js";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";

/** Структурная проверка контракта (без инстанцирования). */
function assertImplementsAgentRuntime(value: AgentRuntime): void {
  expect(typeof value.startRun).toBe("function");
  expect(typeof value.resumeRun).toBe("function");
  expect(typeof value.cancelRun).toBe("function");
  expect(typeof value.inspectRun).toBe("function");
  expect(typeof value.collectResult).toBe("function");
  expect(typeof value.collectUsage).toBe("function");
  expect(typeof value.runResult).toBe("function");
  expect(typeof value.healthCheck).toBe("function");
  expect(typeof value.active).toBe("number");
  expect(typeof value.maxActive).toBe("number");
  expect(Array.isArray(value.calls)).toBe(true);
}

describe("agent-runtime: интерфейс", () => {
  it("HermesRuntimeAdapter сохранён и по-прежнему реализует AgentRuntime", () => {
    // класс импортируется без ошибок; его прототип содержит все методы контракта
    const proto = HermesRuntimeAdapter.prototype as unknown as Record<string, unknown>;
    for (const method of ["startRun", "resumeRun", "cancelRun", "inspectRun", "collectResult", "collectUsage", "runResult", "healthCheck"] as const) {
      expect(typeof proto[method]).toBe("function");
    }
  });

  it("ProviderAgentRuntime реализует AgentRuntime (структурно)", () => {
    const runtime = new ProviderAgentRuntime({
      gateway: { execute: async () => ({ status: 200, headers: {}, body: "{}", finalUrl: "", durationMs: 0, redirected: false }) } as never,
      credentialStore: { resolveCredentialForRun: async () => new Uint8Array() } as never,
      settingsRepository: { getConfigSnapshot: () => undefined } as never,
      loadCapability: async () => {
        throw new Error("unused");
      },
    });
    assertImplementsAgentRuntime(runtime);
  });

  it("AgentRuntimeRun расширен providerSelection без потери hermesSelection", () => {
    const run: AgentRuntimeRun = {
      id: "r1",
      role: "developer",
      runtime: "provider",
      model: "m",
      taskId: null,
      epicId: null,
      status: "STARTED",
      sessionId: null,
      attempt: 1,
      triggerReason: "task-assignment",
      contextVersion: null,
      outputSchemaVersion: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      cost: null,
      providerSelection: {
        runId: "r1",
        providerId: "openai",
        modelId: "m",
        authMethodId: "api-key",
        configRevision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(run.providerSelection?.providerId).toBe("openai");
    expect(run.hermesSelection).toBeUndefined();
  });

  it("RunOutcome несёт providerError-классификацию (тип)", () => {
    const outcome: RunOutcome = {
      success: false,
      exitCode: -1,
      output: "",
      diagnostics: {
        runId: "r1",
        sessionId: null,
        stderr: "",
        stderrCategory: "NETWORK",
        exitCode: -1,
        artifactReferences: [],
        providerError: {
          id: "E6020",
          code: "NETWORK_FORBIDDEN_DESTINATION",
          category: "network",
          severity: "critical",
          attribution: "system",
          retryable: false,
        },
      },
    };
    expect(outcome.diagnostics?.providerError?.code).toBe("NETWORK_FORBIDDEN_DESTINATION");
  });
});
