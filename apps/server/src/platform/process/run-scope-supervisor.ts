import type { ProcessResult } from "./process-executor.js";
import type { ProcessInspector, ProcessScopeIdentity, ProcessScopeObservation } from "./process-inspector.js";

export interface ProcessScopeLaunchRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Secret bytes stay in memory and travel only as a bounded stdin frame. */
  readonly secret?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface ProcessScopeHandle {
  /** Completion means the OS-owned scope is verified empty, not only that its root exited. */
  readonly completion: Promise<ProcessResult>;
}

/** Явное доказательство supervisor, что отменённый запуск не пересёк OS-dispatch barrier. */
export class ProcessScopeLaunchNotDispatchedError extends Error {
  constructor() {
    super("Process-scope launch was cancelled before OS dispatch.");
    this.name = "ProcessScopeLaunchNotDispatchedError";
  }
}

/**
 * Владеет запуском и остановкой всех процессов конкретного durable Run scope.
 * Методы не должны считать прямой child exit или PID lookup доказательством пустой группы.
 */
export interface ProcessScopeSupervisor extends ProcessInspector {
  /**
   * Создаёт OS scope, подтверждает membership, дожидается durable identity callback и только затем
   * разрешает wrapper продолжить payload. Ошибка callback запрещает dispatch Hermes.
   */
  launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle>;
  /** Останавливает только именованный scope данного owner; ambiguous identity остаётся UNKNOWN. */
  stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation>;
  /** Poll-ит authoritative OS membership с bounded timeout. */
  waitForStopped(owner: ProcessScopeIdentity, timeoutMs?: number): Promise<ProcessScopeObservation>;
}

/**
 * Кодирует только provider secret в bounded, length-prefixed stdin frame.
 * Пустой frame означает отсутствие provider credential; значение не попадает в argv/environment.
 *
 * @param secret Уже разрешённый SecretStore value или undefined для provider-free запуска.
 * @returns 4-byte big-endian length и максимум 8192 UTF-8 bytes.
 * @throws {TypeError} Для NUL/newline или превышения transport bound.
 */
export function encodeSecretFrame(secret: string | undefined): Uint8Array {
  if (secret !== undefined && (/\0|\r|\n/.test(secret) || Buffer.byteLength(secret, "utf8") > 8192)) {
    throw new TypeError("Process-scope secret frame is invalid or exceeds 8192 bytes.");
  }
  const body = secret === undefined ? Buffer.alloc(0) : Buffer.from(secret, "utf8");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}
