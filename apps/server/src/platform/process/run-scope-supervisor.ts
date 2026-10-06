import type { ProcessResult } from "./process-executor.js";
import type { ProcessInspector, ProcessScopeIdentity, ProcessScopeObservation } from "./process-inspector.js";
import type { HermesLaunchTicket } from "../../modules/runtime/hermes/hermes-launch-ticket.js";

export interface ProcessScopeLaunchRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Попытка Run; обязательна при переданном Hermes launch ticket. */
  readonly attempt?: number | null;
  /** Opaque one-shot authorization, required for every Hermes CLI launch. */
  readonly hermesLaunchTicket?: HermesLaunchTicket;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** Ограниченный live consumer exact payload stdout; helper protocol bytes сюда не передаются. */
  readonly onStdoutChunk?: (chunk: Uint8Array) => Promise<void>;
  /** Сохранять ли stdout/stderr в ProcessResult; live observer может отключить raw retention. */
  readonly captureOutput?: boolean;
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
