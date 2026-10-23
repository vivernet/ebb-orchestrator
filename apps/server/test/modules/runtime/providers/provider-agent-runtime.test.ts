/**
 * Тесты ProviderAgentRuntime (plan-24, Task 3).
 *
 * Ключевые контракты:
 *  - инструменты выполняются ТОЛЬКО через McpServer.callTool (ActionGateway);
 *  - единственный успех — валидированный submit_result; после успеха — stop;
 *  - нет fallback на другой провайдер/модель после ошибок;
 *  - credentials разрешаются на каждый запрос по (providerId, authMethodId,
 *    configRevision) и обнуляются после использования.
 */

import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { RunCapability, type ToolId } from "../../../../src/modules/execution/run-capability.js";
import { ProviderAgentRuntime } from "../../../../src/modules/runtime/providers/provider-agent-runtime.js";
import { ProviderNetworkGateway, ProviderGatewayError } from "../../../../src/modules/runtime/providers/provider-network-gateway.js";
import { ProviderAdapterRegistry } from "../../../../src/modules/runtime/providers/adapters/registry.js";
import type { ProviderCredentialStore } from "../../../../src/modules/runtime/providers/provider-credential-store.js";
import type { ProviderSettingsRepository, RunProviderSelectionRecord } from "../../../../src/modules/runtime/providers/provider-settings-repository.js";
import type { CompletionStore } from "../../../../src/modules/execution/mcp/submit-result-tool.js";
import type {
  ProviderChatAdapter,
  ProviderChatRequestInput,
  ProviderPreparedRequest,
  ProviderStreamParser,
} from "../../../../src/modules/runtime/providers/provider-runtime-port.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";

const DEVELOPER_SUBMISSION = {
  version: "1.0.0",
  summary: "ok",
  outcome: "COMPLETED",
  commitSha: "a".repeat(40),
};

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    role: "developer",
    runtime: "provider",
    model: "gpt-4o",
    taskId: "task-1",
    epicId: null,
    status: "STARTED",
    sessionId: null,
    attempt: 1,
    triggerReason: "task-assignment",
    contextVersion: "1.0.0",
    outputSchemaVersion: "1.0.0",
    startedAt: null,
    endedAt: null,
    exitCode: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    cost: null,
    capabilityRef: "cap-1",
    prompt: "Сделай задачу и отчитайся через submit_result.",
    ...overrides,
  };
}

/** Fake-адаптер с управляемыми сценариями. */
class FakeAdapter implements ProviderChatAdapter {
  public providerId = "openai";
  public protocolFamily = "openai-compatible" as const;
  public auth = { kind: "bearer" } as const;
  public scenarios: Array<{ toolCalls?: Array<{ id: string; name: string; args: string }>; content?: string; usage?: { input?: number; output?: number }; finish?: "stop" | "tool_calls" | "length" | "content_filter" | "other" | null; error?: Error }> = [];
  public buildCalls = 0;

  public buildRequest(input: ProviderChatRequestInput & { readonly endpoint: string }): ProviderPreparedRequest {
    this.buildCalls += 1;
    return {
      method: "POST",
      url: `${input.endpoint}/chat/completions`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, messages: input.messages }),
      auth: this.auth,
      allowLocalEndpoint: false,
    };
  }

  public parseCompletion(_body: unknown): ReturnType<ProviderChatAdapter["parseCompletion"]> {
    const scenario = this.scenarios.shift();
    if (scenario?.error) throw scenario.error;
    const toolCalls = (scenario?.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.args },
    }));
    return {
      id: "chunk-1",
      model: "gpt-4o",
      content: scenario?.content ?? "",
      toolCalls,
      finishReason: scenario?.finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      usage: {
        inputTokens: scenario?.usage?.input ?? 1,
        cachedInputTokens: 0,
        outputTokens: scenario?.usage?.output ?? 1,
        cost: null,
      },
    };
  }

  public createStreamParser(): ProviderStreamParser {
    throw new Error("stream not used in tests");
  }
}

class FakeRegistry extends ProviderAdapterRegistry {
  public constructor(private readonly adapter: FakeAdapter) {
    super([{ id: "openai" }]);
  }
  public override createAdapter(_providerId: string): ProviderChatAdapter {
    return this.adapter;
  }
}

class FakeCredentialStore implements Pick<ProviderCredentialStore, "resolveCredentialForRun"> {
  public calls: Array<{ providerId: string; authMethodId: string; configRevision: number }> = [];
  public lastBuffer: Uint8Array | null = null;
  public constructor(private readonly fail = false) {}
  public async resolveCredentialForRun(providerId: string, authMethodId: string, configRevision: number): Promise<Uint8Array> {
    if (this.fail) throw new Error("Credential for 'openai/api-key' is not configured");
    this.calls.push({ providerId, authMethodId, configRevision });
    const buffer = new Uint8Array([115, 107, 45, 115, 101, 99, 114, 101, 116]); // "sk-secret"
    this.lastBuffer = buffer;
    return buffer;
  }
}

class FakeSettingsRepository implements Pick<ProviderSettingsRepository, "getConfigSnapshot"> {
  public constructor(private readonly snapshot?: { config: Record<string, unknown> }) {}
  public getConfigSnapshot(_providerId: string, _revision: number) {
    return this.snapshot ? { ...this.snapshot, revision: _revision, providerId: _providerId, selectedAuthMethod: "api-key", modelSelection: { defaultModelId: null, roleDefaults: {} }, capturedAt: "2026-01-01T00:00:00.000Z" } : undefined;
  }
}

class FakeGateway {
  public calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  public responses: Array<{ status: number; body: string } | Error | ((spec: { signal?: AbortSignal }) => Promise<{ status: number; body: string }>)> = [];
  public async execute(spec: { method: string; url: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) {
    this.calls.push({
      url: spec.url,
      headers: spec.headers,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
    });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next({ ...(spec.signal ? { signal: spec.signal } : {}) });
    return next ?? { status: 200, body: "{}" };
  }
}

function setup(options: {
  scenarios?: FakeAdapter["scenarios"];
  responses?: FakeGateway["responses"];
  allowedTools?: string[];
  credentialFail?: boolean;
  selection?: Partial<RunProviderSelectionRecord>;
} = {}) {
  const adapter = new FakeAdapter();
  adapter.scenarios = options.scenarios ?? [];
  const gateway = new FakeGateway();
  gateway.responses = options.responses ?? [];
  const credentials = new FakeCredentialStore(options.credentialFail);
  const repository = new FakeSettingsRepository({ config: { endpoint: "https://api.test.local/v1" } });
  const completions: CompletionStore = {
    accept: async (reference, _value) => {
      if (reference !== "cap-1") return false;
      return true;
    },
  };
  const workspace = path.join(os.tmpdir(), `ebb-provider-runtime-test-${Date.now()}`);
  const capability = new RunCapability({
    id: "cap-1",
    capabilityRef: "cap-1",
    runId: "run-1",
    role: "developer",
    workspace,
    allowedTools: (options.allowedTools ?? ["workspace.read", "submit_result"]) as ToolId[],
  });
  const registry = new FakeRegistry(adapter);
  const runtime = new ProviderAgentRuntime({
    gateway: gateway as unknown as ProviderNetworkGateway,
    credentialStore: credentials as unknown as ProviderCredentialStore,
    settingsRepository: repository as unknown as ProviderSettingsRepository,
    registry,
    completion: completions,
    loadCapability: async () => capability,
    maxTurns: 10,
  });
  const selection: RunProviderSelectionRecord = {
    runId: "run-1",
    providerId: "openai",
    modelId: "gpt-4o",
    authMethodId: "api-key",
    configRevision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...options.selection,
  };
  return { adapter, gateway, credentials, runtime, capability, selection, run: makeRun() };
}

describe("ProviderAgentRuntime: инструменты только через ActionGateway-путь", () => {
  it("каждый tool_call проходит через McpServer (schema + allowedTools)", async () => {
    const { gateway, runtime, selection, run } = setup({
      scenarios: [
        {
          content: "",
          toolCalls: [
            { id: "call_1", name: "workspace.read", args: '{"path":"a.txt"}' },
            { id: "call_2", name: "submit_result", args: JSON.stringify({ payload: DEVELOPER_SUBMISSION }) },
          ],
          finish: "tool_calls",
        },
      ],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    // инструменты исполнены и run завершён успешно
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(true);
    expect(outcome.validatedSubmission).toBe(true);
    // единственный запрос к провайдеру
    expect(gateway.calls.length).toBe(1);
    // usage собран
    const usage = await runtime.collectUsage("run-1");
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  it("неизвестный/неразрешённый инструмент не исполняется и возвращает ошибку модели", async () => {
    const { gateway, runtime, selection, run } = setup({
      allowedTools: ["workspace.read", "submit_result"],
      scenarios: [
        {
          toolCalls: [{ id: "call_1", name: "command.exec", args: '{"policyId":"p","args":[]}' }],
          finish: "tool_calls",
        },
        { content: "завершаю без submit", finish: "stop" },
      ],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
    expect(outcome.validatedSubmission).toBe(false);
    // и gateway-запросы происходили, и инструмент не был исполнен вне mcp
    expect(gateway.calls.length).toBe(2);
    expect(outcome.diagnostics?.submitResultCalls).toBe(0);
  });

  it("прямое исполнение инструментов вне mcp невозможно структурно (tool_call → mcp.callTool)", async () => {
    // инструменты могут исполняться только через McpServer.callTool: подменяем
    // его счётчиком и убеждаемся, что единственный способ исполнения — он.
    const { runtime, selection, run } = setup({
      scenarios: [
        {
          toolCalls: [{ id: "call_1", name: "workspace.read", args: '{"path":"x"}' }],
          finish: "tool_calls",
        },
        { content: "стоп", finish: "stop" },
      ],
    });
    const { McpServer } = await import("../../../../src/modules/execution/mcp/mcp-server.js");
    const originalCallTool = McpServer.prototype.callTool;
    let mcpCalls = 0;
    McpServer.prototype.callTool = async function (this: InstanceType<typeof McpServer>, name: string, args: unknown) {
      mcpCalls += 1;
      return originalCallTool.call(this, name, args);
    };
    try {
      await runtime.startRun({ ...run, providerSelection: selection });
      const outcome = await runtime.collectResult("run-1");
      expect(mcpCalls).toBe(1); // ровно один tool_call исполнен через mcp
      expect(outcome.success).toBe(false);
    } finally {
      McpServer.prototype.callTool = originalCallTool;
    }
  });
});

describe("ProviderAgentRuntime: stop после успешного submit_result", () => {
  it("не выполняет последующие tool_calls после успеха submit_result", async () => {
    const { gateway, runtime, selection, run } = setup({
      scenarios: [
        {
          toolCalls: [
            { id: "call_1", name: "submit_result", args: JSON.stringify({ payload: DEVELOPER_SUBMISSION }) },
            { id: "call_2", name: "workspace.patch", args: '{"path":"a.txt","patches":[]}' },
          ],
          finish: "tool_calls",
        },
      ],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(true);
    // только один провайдер-запрос, никаких повторных ходов
    expect(gateway.calls.length).toBe(1);
    expect(outcome.diagnostics?.submitResultToolUses).toBe(1);
    expect(outcome.diagnostics?.submitResultCalls).toBe(1);
  });
});

describe("ProviderAgentRuntime: нет fallback после ошибок", () => {
  it("ошибка шлюза → типизированная диагностика, один запрос, без смены провайдера", async () => {
    const { gateway, runtime, selection, run } = setup({
      responses: [new ProviderGatewayError("forbidden-destination")],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
    expect(outcome.diagnostics?.providerError?.code).toBe("NETWORK_FORBIDDEN_DESTINATION");
    expect(outcome.diagnostics?.stderrCategory).toBe("NETWORK");
    expect(gateway.calls.length).toBe(1);
  });

  it("HTTP 401 → AUTH_INVALID_CREDENTIALS, без повторных запросов", async () => {
    const { gateway, runtime, selection, run } = setup({
      responses: [{ status: 401, body: JSON.stringify({ error: { message: "invalid api key" } }) }],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
    expect(outcome.diagnostics?.providerError?.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(gateway.calls.length).toBe(1);
  });

  it("нет повторных попыток при ошибке адаптера/парсинга", async () => {
    const { gateway, runtime, selection, run } = setup({
      scenarios: [{ error: new Error("boom") }],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
    expect(gateway.calls.length).toBe(1);
  });
});

describe("ProviderAgentRuntime: credentials", () => {
  it("разрешаются на каждый запрос и обнуляются после использования", async () => {
    const { credentials, runtime, selection, run } = setup({
      scenarios: [
        {
          toolCalls: [{ id: "call_1", name: "workspace.read", args: '{"path":"a.txt"}' }],
          finish: "tool_calls",
        },
        {
          toolCalls: [
            { id: "call_2", name: "submit_result", args: JSON.stringify({ payload: DEVELOPER_SUBMISSION }) },
          ],
          finish: "tool_calls",
        },
      ],
    });
    await runtime.startRun({ ...run, providerSelection: selection });
    expect(credentials.calls).toHaveLength(2);
    for (const call of credentials.calls) {
      expect(call).toEqual({ providerId: "openai", authMethodId: "api-key", configRevision: 1 });
    }
    expect(credentials.lastBuffer).not.toBeNull();
    for (const byte of credentials.lastBuffer!) {
      expect(byte).toBe(0);
    }
  });

  it("отсутствие credential → AUTH_INVALID_CREDENTIALS (fail-closed)", async () => {
    const { gateway, runtime, selection, run } = setup({ credentialFail: true });
    await runtime.startRun({ ...run, providerSelection: selection });
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
    expect(outcome.diagnostics?.providerError?.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(gateway.calls.length).toBe(0);
  });
});

describe("ProviderAgentRuntime: lifecycle", () => {
  it("cancelRun прерывает run и помечает CANCELLED", async () => {
    const { runtime, selection, run } = setup({
      responses: [
        ({ signal }) => new Promise<{ status: number; body: string }>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
        }),
      ],
    });
    const startPromise = runtime.startRun({ ...run, providerSelection: selection });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.cancelRun("run-1");
    await startPromise;
    const inspected = await runtime.inspectRun("run-1");
    expect(inspected.status).toBe("CANCELLED");
    const outcome = await runtime.collectResult("run-1");
    expect(outcome.success).toBe(false);
  });

  it("inspectRun/collectResult бросают для неизвестного run", async () => {
    const { runtime } = setup();
    await expect(runtime.inspectRun("nope")).rejects.toThrow(/not found/);
    await expect(runtime.collectResult("nope")).rejects.toThrow(/not found/);
  });

  it("startRun без выбора провайдера — preflight-ошибка", async () => {
    const { runtime, run } = setup();
    // startRun бросает синхронно до первого await (preflight)
    expect(() => runtime.startRun(run)).toThrow(/PROVIDER_RUN_SELECTION_UNAVAILABLE/);
  });

  it("healthCheck возвращает true", async () => {
    const { runtime } = setup();
    await expect(runtime.healthCheck()).resolves.toBe(true);
  });

  it("изображенческий/cloud-identity провайдер отклоняется в preflight", async () => {
    const gateway = new FakeGateway();
    const credentials = new FakeCredentialStore();
    const repository = new FakeSettingsRepository();
    const runtime = new ProviderAgentRuntime({
      gateway: gateway as unknown as ProviderNetworkGateway,
      credentialStore: credentials as unknown as ProviderCredentialStore,
      settingsRepository: repository as unknown as ProviderSettingsRepository,
      loadCapability: async () => {
        throw new Error("unused");
      },
    });
    expect(() =>
      runtime.startRun({
        ...makeRun(),
        providerSelection: {
          runId: "run-1",
          providerId: "bfl",
          modelId: "flux",
          authMethodId: "api-key",
          configRevision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toThrow(/REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED/);
  });
});
