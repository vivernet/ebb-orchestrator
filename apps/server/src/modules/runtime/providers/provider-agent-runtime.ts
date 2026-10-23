/**
 * PAgentRuntime — реализация `AgentRuntime` поверх провайдеров
 * (plan-24, Task 3).
 *
 * Инварианты:
 *  - инструменты выполняются ТОЛЬКО через существующий контролируемый путь
 *    `McpServer.callTool` (ToolRegistry → ActionGateway): никаких прямых
 *    операций с файловой системой/git/сетью из рантайма;
 *  - единственное успешное завершение — валидированный `submit_result` через
 *    тот же канал; после успеха run останавливается;
 *  - credentials разрешаются на каждый запрос через
 *    `resolveCredentialForRun(providerId, authMethodId, configRevision)` и
 *    обнуляются после использования; без fallback и без повторных попыток
 *    на другом провайдере/модели после ошибок;
 *  - ошибки провайдера/сети преобразуются в типизированные безопасные
 *    диагностики (классификация таксономии), без сохранения сырого текста.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import { McpServer } from "../../execution/mcp/mcp-server.js";
import type { CompletionStore } from "../../execution/mcp/submit-result-tool.js";
import type { RunCapability } from "../../execution/run-capability.js";
import { getProvider } from "./provider-catalog.js";
import type { AgentRuntime, AgentRuntimeRun } from "../agent-runtime.js";
import { UsageCounter, type ModelUsage } from "../usage-counter.js";
import type { RunOutcome } from "../run-types.js";
import type { ErrorCategory } from "../provider-errors.js";
import {
  ProviderRuntimeError,
  classifyHttpError,
  classifyTransportError,
} from "./provider-error-mapper.js";
import { ProviderNetworkGateway } from "./provider-network-gateway.js";
import type { ProviderCredentialStore } from "./provider-credential-store.js";
import {
  attachCredentialToRequest,
  safeParseArguments,
} from "./provider-request.js";
import type { ProviderChatAdapter, ProviderChatMessage, ProviderToolDefinition } from "./provider-runtime-port.js";
import { ProviderAdapterRegistry, PROVIDER_ADAPTER_REGISTRY } from "./adapters/registry.js";
import type { ProviderSettingsRepository, RunProviderSelectionRecord } from "./provider-settings-repository.js";
import { zeroBuffer } from "./provider-credential-store.js";

/** Максимальное число provider-ходов (запросов) до принудительной остановки. */
export const DEFAULT_PROVIDER_MAX_TURNS = 64;

/** Ошибка: выбор провайдера для Run отсутствует (потребляет Task 5). */
export class ProviderRunSelectionUnavailableError extends Error {
  public constructor(runId: string) {
    super(`PROVIDER_RUN_SELECTION_UNAVAILABLE:${runId}`);
    this.name = "ProviderRunSelectionUnavailableError";
  }
}

/** Ошибка: capability для Run недоступна. */
export class ProviderRunCapabilityUnavailableError extends Error {
  public constructor(runId: string) {
    super(`PROVIDER_RUN_CAPABILITY_UNAVAILABLE:${runId}`);
    this.name = "ProviderRunCapabilityUnavailableError";
  }
}

/** Входные зависимости рантайма. */
export interface ProviderAgentRuntimeOptions {
  readonly gateway: ProviderNetworkGateway;
  readonly credentialStore: ProviderCredentialStore;
  readonly settingsRepository: ProviderSettingsRepository;
  readonly registry?: ProviderAdapterRegistry;
  readonly completion?: CompletionStore;
  readonly loadCapability: (capabilityRef: string) => Promise<RunCapability> | RunCapability;
  readonly selectionResolver?: (runId: string) => RunProviderSelectionRecord | undefined;
  readonly maxTurns?: number;
  readonly systemPromptBuilder?: (run: AgentRun) => string;
}

interface ProviderToolStats {
  uses: number;
  successes: number;
  errors: number;
}

interface ProviderRunState {
  run: AgentRun;
  selection: RunProviderSelectionRecord;
  capability: RunCapability;
  mcp: McpServer;
  adapter: ProviderChatAdapter;
  messages: ProviderChatMessage[];
  usage: UsageCounter;
  outcome: RunOutcome | null;
  abortController: AbortController;
  cancelled: boolean;
  finished: boolean;
  startedAt: Date;
  toolStats: Map<string, ProviderToolStats>;
  submitResultUses: number;
  submitResultCalls: number;
  submitResultErrors: number;
  totalToolCalls: number;
}

/** В-памяти completion-store (тесты/standalone). */
class InMemoryCompletionStore implements CompletionStore {
  private accepted = new Map<string, { runId: string; role: string; output: unknown }>();
  public async accept(reference: string, value: { runId: string; role: string; output: unknown }): Promise<boolean> {
    if (this.accepted.has(reference)) return false;
    this.accepted.set(reference, value);
    return true;
  }
  public getSubmission(runId: string): { runId: string; role: string; output: string } | undefined {
    for (const value of this.accepted.values()) {
      if (value.runId === runId) return { runId, role: value.role, output: JSON.stringify(value.output) };
    }
    return undefined;
  }
}

const LEGACY_STDERR_CATEGORY_BY_ERROR_CATEGORY: Partial<Record<ErrorCategory, NonNullable<NonNullable<RunOutcome["diagnostics"]>["stderrCategory"]>>> = {
  auth: "AUTH",
  quota: "RATE_LIMIT",
  capacity: "RATE_LIMIT",
  network: "NETWORK",
};

function legacyStderrCategory(category: ErrorCategory): NonNullable<NonNullable<RunOutcome["diagnostics"]>["stderrCategory"]> {
  return LEGACY_STDERR_CATEGORY_BY_ERROR_CATEGORY[category] ?? "OTHER";
}

function defaultSystemPrompt(run: AgentRun): string {
  return [
    `Task: ${run.taskId ?? "N/A"}`,
    `Role: ${run.role}`,
    `Context version: ${run.contextVersion ?? ""}`,
    "Use the Orchestrator tools only.",
    "Submit one successful structured result with submit_result before ending. If submit_result returns a validation error, correct the payload and retry; after success, do not call submit_result again.",
  ].join("\n");
}

const MAX_TOOL_RESULT_CHARACTERS = 16 * 1024;

function toolResultContent(result: { success: boolean; result?: unknown; error?: string }): string {
  const payload = result.success
    ? { success: true, result: result.result }
    : { success: false, error: result.error };
  const json = JSON.stringify(payload);
  return json.length > MAX_TOOL_RESULT_CHARACTERS ? json.slice(0, MAX_TOOL_RESULT_CHARACTERS) : json;
}

/**
 * Рантайм агента поверх AI-провайдеров.
 */
export class ProviderAgentRuntime implements AgentRuntime {
  public active = 0;
  public maxActive = 0;
  public readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];

  private readonly runs = new Map<string, ProviderRunState>();
  private readonly options: Required<Pick<ProviderAgentRuntimeOptions, "maxTurns">> & ProviderAgentRuntimeOptions;
  private readonly completion: CompletionStore;
  private readonly registry: ProviderAdapterRegistry;

  public constructor(options: ProviderAgentRuntimeOptions) {
    this.options = { maxTurns: DEFAULT_PROVIDER_MAX_TURNS, ...options };
    this.completion = options.completion ?? new InMemoryCompletionStore();
    this.registry = options.registry ?? PROVIDER_ADAPTER_REGISTRY;
  }

  /** Запускает run провайдера; возвращает Promise до терминального состояния. */
  public startRun(run: AgentRuntimeRun): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`RUN_START_ALREADY_IN_PROGRESS:${run.id}`);
    const selection = run.providerSelection ?? this.options.selectionResolver?.(run.id);
    if (!selection) throw new ProviderRunSelectionUnavailableError(run.id);

    const providerDefinition = this.registry.get(selection.providerId);
    if (!providerDefinition) throw new ProviderRuntimeError("CONFIG_ENDPOINT_MISSING", `unknown-provider:${selection.providerId}`);
    if (!providerDefinition.capabilities.includes("chat")) {
      throw new ProviderRuntimeError(
        "REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED",
        `REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED:${selection.providerId}:chat`,
      );
    }

    if (!run.capabilityRef) throw new ProviderRunCapabilityUnavailableError(run.id);
    const capabilityPromise = Promise.resolve(this.options.loadCapability(run.capabilityRef));
    const adapter = this.registry.createAdapter(selection.providerId);

    this.calls.push({
      phase: "provider",
      role: run.role,
      ...(run.taskId ? { taskId: run.taskId } : {}),
    });

    return capabilityPromise.then(async (capability) => {
      const mcp = new McpServer(capability, { completion: this.completion, expectedRunId: run.id, expectedRole: run.role });
      const state: ProviderRunState = {
        run: { ...run, status: "IN_PROGRESS", startedAt: new Date() },
        selection,
        capability,
        mcp,
        adapter,
        messages: [],
        usage: new UsageCounter(),
        outcome: null,
        abortController: new AbortController(),
        cancelled: false,
        finished: false,
        startedAt: new Date(),
        toolStats: new Map(),
        submitResultUses: 0,
        submitResultCalls: 0,
        submitResultErrors: 0,
        totalToolCalls: 0,
      };
      this.runs.set(run.id, state);
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        await this.runLoop(state);
      } finally {
        this.active -= 1;
      }
    });
  }

  /** Возобновление: provider-рантайм без durable-сессии не поддерживает resume. */
  public async resumeRun(): Promise<void> {
    throw new Error("PROVIDER_RESUME_UNAVAILABLE");
  }

  /** Отменяет run: прерывает активный запрос и помечает run отменённым. */
  public async cancelRun(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    state.cancelled = true;
    state.abortController.abort();
    if (!state.finished) {
      state.finished = true;
      state.run = { ...state.run, status: "CANCELLED", endedAt: new Date() };
      state.outcome = {
        success: false,
        exitCode: -1,
        output: "",
        validatedSubmission: false,
        diagnostics: {
          runId,
          sessionId: null,
          stderr: "",
          stderrCategory: "OTHER",
          exitCode: -1,
          artifactReferences: [],
          ...this.diagnosticCounts(state),
        },
      };
    }
  }

  /** Возвращает текущий снимок run. */
  public async inspectRun(runId: string): Promise<AgentRun> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    return state.run;
  }

  private diagnosticCounts(state: ProviderRunState): {
    submitResultToolUses?: number;
    submitResultCalls?: number;
    submitResultErrors?: number;
  } {
    return {
      submitResultToolUses: state.submitResultUses,
      submitResultCalls: state.submitResultCalls,
      submitResultErrors: state.submitResultErrors,
    };
  }

  /** Возвращает результат run (типизированный исход). */
  public async collectResult(runId: string): Promise<RunOutcome> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Run ${runId} not found`);
    if (state.outcome) return state.outcome;
    return {
      success: false,
      exitCode: -1,
      output: "AGENT_OUTPUT_MISSING",
      validatedSubmission: false,
      diagnostics: {
        runId,
        sessionId: null,
        stderr: "",
        stderrCategory: "OTHER",
        exitCode: -1,
        artifactReferences: [],
        ...this.diagnosticCounts(state),
      },
    };
  }

  /** Возвращает usage run. */
  public async collectUsage(runId: string): Promise<ModelUsage> {
    const state = this.runs.get(runId);
    if (!state?.usage || state.usage.isEmpty) {
      throw new Error(`PROVIDER_USAGE_MISSING: no usage values were emitted for run ${runId}`);
    }
    return state.usage.snapshot();
  }

  /** Алиас результата (контракт AgentRuntime). */
  public async runResult(runId: string): Promise<RunOutcome> {
    return this.collectResult(runId);
  }

  /** Проверка здоровья: зависимости сконструированы. */
  public async healthCheck(): Promise<boolean> {
    return true;
  }

  /* ---------------- внутренний цикл ---------------- */

  private async runLoop(state: ProviderRunState): Promise<void> {
    const { run, selection } = state;
    const systemPrompt = this.options.systemPromptBuilder?.(run) ?? defaultSystemPrompt(run);
    state.messages.push({ role: "system", content: systemPrompt });
    state.messages.push({ role: "user", content: run.prompt ?? "" });

    const config = this.options.settingsRepository.getConfigSnapshot(selection.providerId, selection.configRevision)?.config;
    const endpoint = this.registry.resolveEndpoint(selection.providerId, config);
    const endpointQuery = this.registry.endpointQuery(selection.providerId, config);
    const declaresLocalEndpointSupport = getProvider(selection.providerId)?.authMethods.includes("local-endpoint") === true;
    const localEndpointAllowed = endpoint.isLocalEndpoint && declaresLocalEndpointSupport;

    try {
      for (let turn = 0; turn < this.options.maxTurns; turn += 1) {
        if (state.cancelled || state.abortController.signal.aborted) return;

        const tools = this.availableTools(state);
        const credential = await this.resolveCredential(state);
        // Секретные байты передаются в заголовок как Buffer (для header-схем —
        // общая память с `credential`; для bearer — Buffer-копия с префиксом),
        // необнуляемая строковая копия секрета не создаётся. Исключение:
        // query-схема auth требует строку в URL (неизбежный GC-only участок).
        // После выполнения запроса все Buffer-значения заголовков и `credential`
        // обнуляются в finally ниже.
        let finalRequest: { url: string; headers: Record<string, string | Buffer>; body: string | null } | null = null;
        try {
          const prepared = state.adapter.buildRequest({
            model: selection.modelId,
            messages: state.messages,
            tools,
            stream: false,
            endpointQuery,
            endpoint: endpoint.baseUrl,
          });
          const credentialHeaderValue = credential === null
            ? null
            : prepared.auth.kind === "query"
              ? Buffer.from(credential).toString("utf8")
              : Buffer.from(credential.buffer, credential.byteOffset, credential.byteLength);
          finalRequest = attachCredentialToRequest(prepared, credentialHeaderValue);
          const response = await this.options.gateway.execute({
            method: prepared.method,
            url: finalRequest.url,
            headers: finalRequest.headers,
            ...(finalRequest.body !== null ? { body: finalRequest.body } : {}),
            allowPrivateDestination: localEndpointAllowed,
            signal: state.abortController.signal,
          });

          if (response.status >= 400) {
            const classification = classifyHttpError(response.status);
            throw new ProviderRuntimeError(classification.code, `HTTP_${response.status}`);
          }

          let body: unknown;
          try {
            body = JSON.parse(response.body) as unknown;
          } catch {
            throw new ProviderRuntimeError("PROVIDER_RESPONSE_PARSE_ERROR", "json");
          }
          const completion = state.adapter.parseCompletion(body);
          state.usage.merge(completion.usage);

          if (completion.toolCalls.length > 0) {
            state.messages.push({
              role: "assistant",
              content: completion.content,
              toolCalls: completion.toolCalls,
            });
            const stopped = await this.executeToolCalls(state, completion.toolCalls);
            if (stopped) return;
            continue;
          }

          // Модель завершила ход без инструментов и без submit_result — run неполон.
          this.finish(state, {
            success: false,
            exitCode: -1,
            output: completion.content.slice(0, 4096),
            validatedSubmission: false,
            diagnostics: {
              runId: run.id,
              sessionId: null,
              stderr: "",
              stderrCategory: "OTHER",
              exitCode: -1,
              artifactReferences: [],
              ...this.diagnosticCounts(state),
            },
          });
          return;
        } finally {
          if (credential !== null) {
            // Секретные байты обнуляются после использования.
            zeroBuffer(credential);
            // Затираем и Buffer-значения заголовков (в т.ч. скопированный
            // Authorization с префиксом «Bearer »).
            for (const value of Object.values(finalRequest?.headers ?? {})) {
              if (Buffer.isBuffer(value)) value.fill(0);
            }
          }
        }
      }
      this.finish(state, {
        success: false,
        exitCode: -1,
        output: "AGENT_TURN_LIMIT_EXCEEDED",
        validatedSubmission: false,
        diagnostics: {
          runId: run.id,
          sessionId: null,
          stderr: "",
          stderrCategory: "OTHER",
          exitCode: -1,
          artifactReferences: [],
          ...this.diagnosticCounts(state),
        },
      });
    } catch (error) {
      if (state.cancelled) return;
      const classification = error instanceof ProviderRuntimeError
        ? error.classification
        : classifyTransportError(error);
      this.finish(state, {
        success: false,
        exitCode: -1,
        output: "",
        validatedSubmission: false,
        diagnostics: {
          runId: run.id,
          sessionId: null,
          stderr: "",
          stderrCategory: legacyStderrCategory(classification.category),
          exitCode: -1,
          artifactReferences: [],
          providerError: {
            id: classification.id,
            code: classification.code,
            category: classification.category,
            severity: classification.severity,
            attribution: classification.attribution,
            retryable: classification.retryable,
          },
          ...this.diagnosticCounts(state),
        },
      });
    }
  }

  private availableTools(state: ProviderRunState): readonly ProviderToolDefinition[] {
    return state.mcp.getAvailableTools().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as ProviderToolDefinition["function"]["parameters"],
      },
    }));
  }

  private async resolveCredential(state: ProviderRunState): Promise<Uint8Array | null> {
    const { selection } = state;
    const reference = this.registry.get(selection.providerId);
    if (!reference || reference.auth.kind === "none") return null;
    try {
      return await this.options.credentialStore.resolveCredentialForRun(
        selection.providerId,
        selection.authMethodId,
        selection.configRevision,
      );
    } catch (error) {
      if (error instanceof Error && /AUTH_DEVICE_FLOW_TOKEN_MISSING|Credential for|not configured|not active|is missing/i.test(error.message)) {
        if (selection.authMethodId === "oauth-device-code") {
          throw new ProviderRuntimeError("AUTH_DEVICE_FLOW_TOKEN_MISSING");
        }
        throw new ProviderRuntimeError("AUTH_INVALID_CREDENTIALS");
      }
      throw new ProviderRuntimeError("AUTH_INVALID_CREDENTIALS");
    }
  }

  /**
   * Выполняет tool_calls модели ТОЛЬКО через McpServer.callTool
   * (ToolRegistry → ActionGateway). Возвращает true, если run завершён
   * успешным submit_result.
   */
  private async executeToolCalls(state: ProviderRunState, calls: readonly { id: string; function: { name: string; arguments: string } }[]): Promise<boolean> {
    for (const call of calls) {
      if (state.cancelled) return true;
      const name = call.function.name;
      const args = safeParseArguments(call.function.arguments) ?? {};
      const stats = state.toolStats.get(name) ?? { uses: 0, successes: 0, errors: 0 };
      stats.uses += 1;
      state.toolStats.set(name, stats);
      state.totalToolCalls += 1;

      const result = await state.mcp.callTool(name, args);

      if (name === "submit_result") {
        state.submitResultUses += 1;
        state.submitResultCalls += 1;
        if (!result.success) state.submitResultErrors += 1;
        else stats.successes += 1;
        if (result.success) {
          this.finish(state, {
            success: true,
            exitCode: 0,
            output: JSON.stringify(result.result),
            validatedSubmission: true,
            diagnostics: {
              runId: state.run.id,
              sessionId: null,
              stderr: "",
              stderrCategory: "EMPTY",
              exitCode: 0,
              artifactReferences: [],
              ...this.diagnosticCounts(state),
            },
          });
          return true;
        }
        stats.errors += 1;
      } else {
        if (result.success) stats.successes += 1;
        else stats.errors += 1;
      }

      state.messages.push({
        role: "tool",
        toolCallId: call.id,
        content: toolResultContent(result),
      });
    }
    return false;
  }

  private finish(state: ProviderRunState, outcome: RunOutcome): void {
    if (state.finished) return;
    state.finished = true;
    state.outcome = outcome;
    state.run = {
      ...state.run,
      status: outcome.success ? "COMPLETED" : state.cancelled ? "CANCELLED" : "FAILED",
      endedAt: new Date(),
      exitCode: outcome.exitCode,
    };
  }
}
