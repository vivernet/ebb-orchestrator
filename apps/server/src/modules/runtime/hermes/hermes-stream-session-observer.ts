import { RUNTIME_TOOL_ERROR_CATEGORIES, type RuntimeDiagnosticToolId, type RuntimeToolErrorCategory, type RuntimeToolEventCounts } from "../run-types.js";

/** Максимум UTF-8-байтов, временно удерживаемых для одной незавершённой строки JSONL. */
export const HERMES_STREAM_MAX_LINE_BYTES = 65_536;

/** Максимальный размер начального события `system/init`, принимаемого как свидетельство сессии. */
export const HERMES_STREAM_MAX_INIT_EVENT_BYTES = 4_096;

/** Конечный список безопасных причин отказа, возвращаемых наблюдателем Hermes-потока. */
export type HermesStreamSessionObserverReason =
  | "INVALID_UTF8"
  | "LINE_TOO_LARGE"
  | "INIT_EVENT_TOO_LARGE"
  | "MALFORMED_JSON"
  | "UNEXPECTED_INITIAL_EVENT"
  | "UNEXPECTED_EVENT"
  | "INVALID_SESSION_ID"
  | "DUPLICATE_INIT"
  | "MISSING_INIT"
  | "STREAM_FINISHED";

/** Единственная проекция события, которую может раскрыть наблюдатель живого Hermes-потока. */
export interface HermesStreamSessionInitProjection {
  readonly type: "system";
  readonly subtype: "init";
  readonly sessionId: string;
}

/** Только проверенные token counts из terminal result той же Hermes-сессии. */
export interface HermesStreamTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

/** Числа вызовов и ошибок для одного разрешённого Hermes tool ID. */
/** Только счётчики фиксированного набора Ebb tools; имена и payload событий не сохраняются. */
export type HermesToolEventCounts = RuntimeToolEventCounts;
type HermesDiagnosticToolId = RuntimeDiagnosticToolId;

/** Совместимый summary `submit_result` для безопасной AGENT_OUTPUT_MISSING ошибки. */
export interface HermesSubmitResultStreamCounts {
  readonly toolUses: number;
  readonly calls: number;
  readonly errors: number;
}

const DIAGNOSTIC_TOOL_NAMES = {
  "workspace.read": ["workspace.read", "mcp__ebb_orchestrator__workspace_read"],
  "workspace.patch": ["workspace.patch", "mcp__ebb_orchestrator__workspace_patch"],
  "workspace.search": ["workspace.search", "mcp__ebb_orchestrator__workspace_search"],
  "project.test": ["project.test", "mcp__ebb_orchestrator__project_test"],
  "git.add": ["git.add", "mcp__ebb_orchestrator__git_add"],
  "git.commit": ["git.commit", "mcp__ebb_orchestrator__git_commit"],
  "git.head": ["git.head", "mcp__ebb_orchestrator__git_head"],
  submit_result: ["submit_result", "mcp__ebb_orchestrator__submit_result"],
} as const satisfies Record<HermesDiagnosticToolId, readonly string[]>;
const DIAGNOSTIC_TOOL_BY_NAME = new Map<string, HermesDiagnosticToolId>(
  Object.entries(DIAGNOSTIC_TOOL_NAMES).flatMap(([id, names]) => names.map((name) => [name, id as HermesDiagnosticToolId])),
);

function emptyToolCounts(): Record<HermesDiagnosticToolId, {
  uses: number;
  results: number;
  successes: number;
  errors: number;
  errorCategories: Record<RuntimeToolErrorCategory, number>;
}> {
  return {
    "workspace.read": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "workspace.patch": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "workspace.search": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "project.test": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "git.add": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "git.commit": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    "git.head": { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
    submit_result: { uses: 0, results: 0, successes: 0, errors: 0, errorCategories: emptyErrorCategories() },
  };
}

function emptyErrorCategories(): Record<RuntimeToolErrorCategory, number> {
  return Object.fromEntries(RUNTIME_TOOL_ERROR_CATEGORIES.map((category) => [category, 0])) as Record<RuntimeToolErrorCategory, number>;
}

/** Безопасный результат разбора без исходных строк Hermes и исключений парсера. */
export type HermesStreamSessionObserverUpdate =
  | { readonly status: "pending" }
  | {
      readonly status: "captured";
      readonly projection?: HermesStreamSessionInitProjection;
    }
  | {
      readonly status: "invalid";
      readonly reason: HermesStreamSessionObserverReason;
    };

type LineResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "captured"; readonly projection: HermesStreamSessionInitProjection }
  | { readonly kind: "invalid"; readonly reason: HermesStreamSessionObserverReason };

const PENDING: HermesStreamSessionObserverUpdate = Object.freeze({ status: "pending" });
const CAPTURED: HermesStreamSessionObserverUpdate = Object.freeze({ status: "captured" });
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Инкрементально проверяет ограниченный stdout Hermes в формате `--format stream-json`.
 * Наблюдатель временно хранит не более одной ограниченной строки, а после разбора — только разрешённый session ID и числовую проекцию usage; буфер исходных байтов очищается после разбора. Парсер не подтверждает идентичность процесса и владельца: это обязан проверить вызывающий код. Если после захвата возвращён `invalid`, вызывающий код обязан сделать ранее сохранённый session ID непригодным для resume.
 */
export class HermesStreamSessionObserver {
  private readonly lineBuffer = new Uint8Array(HERMES_STREAM_MAX_LINE_BYTES);
  private lineLength = 0;
  private capturedSessionId: string | null = null;
  private invalidReason: HermesStreamSessionObserverReason | null = null;
  private finished = false;
  private finishUpdate: HermesStreamSessionObserverUpdate | null = null;
  private terminalResultSeen = false;
  private tokenUsage: HermesStreamTokenUsage | null = null;
  private readonly toolEventCounts = emptyToolCounts();

  /** Возвращает только числовую проекцию одного correlated result; неизвестный cost здесь не выводится. */
  get usage(): HermesStreamTokenUsage | null {
    return this.tokenUsage;
  }

  /** Возвращает только количество вызовов `submit_result` и ответов с `is_error: true`. */
  get submitResultCounts(): HermesSubmitResultStreamCounts {
    const submitResult = this.toolEventCounts.submit_result;
    return Object.freeze({
      toolUses: Object.values(this.toolEventCounts).reduce((total, counts) => Math.min(Number.MAX_SAFE_INTEGER, total + counts.uses), 0),
      calls: submitResult.uses,
      errors: submitResult.errors,
    });
  }

  /** Возвращает только bounded counters для разрешённых Ebb tool IDs. */
  get toolEventCountsSnapshot(): HermesToolEventCounts {
    return Object.freeze(Object.fromEntries(
      Object.entries(this.toolEventCounts).map(([id, counts]) => [id, Object.freeze({
        ...counts,
        errorCategories: Object.freeze({ ...counts.errorCategories }),
      })]),
    ) as HermesToolEventCounts);
  }

  /**
   * Принимает очередной фрагмент байтов stdout того же Hermes-процесса.
   * Границы фрагмента могут проходить внутри UTF-8-символа, JSON-токена или строки JSONL.
   * Возвращает только безопасный статус, фиксированную причину отказа либо однократную разрешённую проекцию; при нарушении протокола ранее захваченный ID отбрасывается.
   *
   * @param chunk Очередной фрагмент stdout в байтах.
   * @returns Результат разбора без исходного вывода Hermes.
   */
  push(chunk: Uint8Array): HermesStreamSessionObserverUpdate {
    if (this.invalidReason) return this.invalidUpdate();
    if (this.finished) return this.invalidate("STREAM_FINISHED");

    let projection: HermesStreamSessionInitProjection | undefined;
    for (const byte of chunk) {
      if (byte === 0x0a) {
        const result = this.consumeLine();
        if (result.kind === "invalid") return this.invalidate(result.reason);
        if (result.kind === "captured") projection = result.projection;
        continue;
      }

      if (this.lineLength === HERMES_STREAM_MAX_LINE_BYTES) {
        return this.invalidate("LINE_TOO_LARGE");
      }
      this.lineBuffer[this.lineLength] = byte;
      this.lineLength += 1;
    }

    if (projection) return this.capturedUpdate(projection);
    return this.capturedSessionId ? CAPTURED : PENDING;
  }

  /**
   * Завершает наблюдение и один раз проверяет последнюю строку без завершающего перевода строки.
   * Если до конца потока допустимое событие не получено, возвращается `MISSING_INIT`; повторный вызов не повторяет проекцию.
   *
   * @returns Безопасный итоговый статус или фиксированная причина отказа.
   */
  finish(): HermesStreamSessionObserverUpdate {
    if (this.finishUpdate) return this.finishUpdate;
    if (this.invalidReason) {
      this.finished = true;
      this.finishUpdate = this.invalidUpdate();
      return this.finishUpdate;
    }
    if (this.finished) return this.invalidate("STREAM_FINISHED");

    this.finished = true;
    let projection: HermesStreamSessionInitProjection | undefined;
    if (this.lineLength > 0) {
      const result = this.consumeLine();
      if (result.kind === "invalid") {
        this.finishUpdate = this.invalidate(result.reason);
        return this.finishUpdate;
      }
      if (result.kind === "captured") projection = result.projection;
    }

    if (!this.capturedSessionId) {
      this.finishUpdate = this.invalidate("MISSING_INIT");
      return this.finishUpdate;
    }

    const result = projection ? this.capturedUpdate(projection) : CAPTURED;
    // The projection is an edge-triggered handoff to the integration callback,
    // never a replayed value from an idempotent second finish().
    this.finishUpdate = CAPTURED;
    return result;
  }

  private consumeLine(): LineResult {
    const lineLength = this.lineLength;
    const eventBytes = lineLength - (lineLength > 0 && this.lineBuffer[lineLength - 1] === 0x0d ? 1 : 0);
    let line: string;
    try {
      // Decode only complete lines: a multibyte UTF-8 character split across
      // process chunks stays in the bounded byte buffer until its line ends.
      line = new TextDecoder("utf-8", { fatal: true }).decode(this.lineBuffer.subarray(0, lineLength));
    } catch {
      this.clearLine();
      return { kind: "invalid", reason: "INVALID_UTF8" };
    }

    this.clearLine();

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return { kind: "invalid", reason: "MALFORMED_JSON" };
    }

    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return { kind: "invalid", reason: this.capturedSessionId ? "UNEXPECTED_EVENT" : "UNEXPECTED_INITIAL_EVENT" };
    }

    const record = event as Record<string, unknown>;
    const isInit = record.type === "system" && record.subtype === "init";
    if (!this.capturedSessionId) {
      if (!isInit) return { kind: "invalid", reason: "UNEXPECTED_INITIAL_EVENT" };
      if (eventBytes > HERMES_STREAM_MAX_INIT_EVENT_BYTES) {
        return { kind: "invalid", reason: "INIT_EVENT_TOO_LARGE" };
      }

      const sessionId = record.session_id;
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        return { kind: "invalid", reason: "INVALID_SESSION_ID" };
      }

      this.capturedSessionId = sessionId;
      return {
        kind: "captured",
        projection: Object.freeze({ type: "system", subtype: "init", sessionId }),
      };
    }

    if (isInit) return { kind: "invalid", reason: "DUPLICATE_INIT" };
    if (typeof record.type !== "string") return { kind: "invalid", reason: "UNEXPECTED_EVENT" };
    const diagnosticToolId = typeof record.name === "string" ? DIAGNOSTIC_TOOL_BY_NAME.get(record.name) : undefined;
    if (diagnosticToolId && record.type === "tool_use") {
      const counts = this.toolEventCounts[diagnosticToolId];
      counts.uses = incrementSafeCounter(counts.uses);
    } else if (diagnosticToolId && record.type === "tool_result") {
      const counts = this.toolEventCounts[diagnosticToolId];
      counts.results = incrementSafeCounter(counts.results);
      if (record.is_error === false) {
        counts.successes = incrementSafeCounter(counts.successes);
      } else if (record.is_error === true) {
        counts.errors = incrementSafeCounter(counts.errors);
        const category = classifyToolError(record.output);
        counts.errorCategories[category] = incrementSafeCounter(counts.errorCategories[category]);
      }
    }
    if (record.type === "result") {
      const duplicate = this.terminalResultSeen;
      this.terminalResultSeen = true;
      this.tokenUsage = null;
      const tokens = record.tokens;
      if (!duplicate && record.session_id === this.capturedSessionId &&
          typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)) {
        const counts = tokens as Record<string, unknown>;
        if (["input", "output", "total", "cache_read", "cache_write"].every((key) =>
          typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key] >= 0)) {
          this.tokenUsage = Object.freeze({
            inputTokens: counts.input as number,
            cachedInputTokens: counts.cache_read as number,
            outputTokens: counts.output as number,
          });
        }
      }
    }
    return { kind: "ignored" };
  }

  private clearLine(): void {
    this.lineBuffer.fill(0, 0, this.lineLength);
    this.lineLength = 0;
  }

  private invalidate(reason: HermesStreamSessionObserverReason): HermesStreamSessionObserverUpdate {
    this.invalidReason = reason;
    this.capturedSessionId = null;
    this.tokenUsage = null;
    this.clearLine();
    const update: HermesStreamSessionObserverUpdate = Object.freeze({ status: "invalid", reason });
    if (this.finished) this.finishUpdate = update;
    return update;
  }

  private invalidUpdate(): HermesStreamSessionObserverUpdate {
    return Object.freeze({ status: "invalid", reason: this.invalidReason ?? "MISSING_INIT" });
  }

  private capturedUpdate(projection: HermesStreamSessionInitProjection): HermesStreamSessionObserverUpdate {
    return Object.freeze({ status: "captured", projection });
  }
}

function incrementSafeCounter(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

/** Классифицирует MCP error output в фиксированную категорию, не сохраняя исходный текст. */
function classifyToolError(output: unknown): RuntimeToolErrorCategory {
  return classifyErrorValue(output, 0, { inspectedStrings: 0 }) ?? "OTHER";
}

function classifyErrorValue(
  value: unknown,
  depth: number,
  state: { inspectedStrings: number },
): RuntimeToolErrorCategory | undefined {
  if (depth > 4 || state.inspectedStrings >= 32) return undefined;
  if (typeof value === "string") {
    state.inspectedStrings += 1;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== value) {
        const parsedCategory = classifyErrorValue(parsed, depth + 1, state);
        if (parsedCategory) return parsedCategory;
      }
    } catch {
      // Plain text is inspected only against the fixed patterns below.
    }
    return classifyErrorText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 16)) {
      const category = classifyErrorValue(item, depth + 1, state);
      if (category) return category;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "error", "message", "text", "output", "content", "result"]) {
    if (!(key in record)) continue;
    const category = classifyErrorValue(record[key], depth + 1, state);
    if (category) return category;
  }
  return undefined;
}

function classifyErrorText(value: string): RuntimeToolErrorCategory | undefined {
  if (/\b(?:INVALID_ARGUMENTS|INVALID_TOOL_ARGS)\b|\binvalid\s+[\w.-]+\s+arguments\b|\bschema validation failed\b/iu.test(value)) {
    return "INVALID_ARGUMENTS";
  }
  if (/\b(?:PERMISSION_DENIED|CAPABILITY_REVOKED)\b|\b(?:unauthori[sz]ed|permission denied|forbidden)\b/iu.test(value)) {
    return "PERMISSION_DENIED";
  }
  if (/\b(?:NOT_AVAILABLE|TOOL_NOT_FOUND)\b|\b(?:not available|unavailable|git not available|tool not found)\b/iu.test(value)) {
    return "NOT_AVAILABLE";
  }
  if (/\bPROCESS_FAILURE\b|\bprocess (?:failed|failure)\b|\bcommand (?:failed|exited)\b|\bexit(?:ed)?(?: code)?\s*[1-9]\d*\b/iu.test(value)) {
    return "PROCESS_FAILURE";
  }
  return undefined;
}
