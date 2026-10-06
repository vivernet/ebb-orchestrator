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
 * Наблюдатель временно хранит не более одной ограниченной строки, а после успешного события — только разрешённый session ID; буфер исходных байтов очищается после разбора. Парсер не подтверждает идентичность процесса и владельца: это обязан проверить вызывающий код. Если после захвата возвращён `invalid`, вызывающий код обязан сделать ранее сохранённый session ID непригодным для resume.
 */
export class HermesStreamSessionObserver {
  private readonly lineBuffer = new Uint8Array(HERMES_STREAM_MAX_LINE_BYTES);
  private lineLength = 0;
  private capturedSessionId: string | null = null;
  private invalidReason: HermesStreamSessionObserverReason | null = null;
  private finished = false;
  private finishUpdate: HermesStreamSessionObserverUpdate | null = null;

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
    return { kind: "ignored" };
  }

  private clearLine(): void {
    this.lineBuffer.fill(0, 0, this.lineLength);
    this.lineLength = 0;
  }

  private invalidate(reason: HermesStreamSessionObserverReason): HermesStreamSessionObserverUpdate {
    this.invalidReason = reason;
    this.capturedSessionId = null;
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
