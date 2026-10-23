import { randomBytes } from "node:crypto";
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";

export interface LockHandle {
  /** PID владельца, сохранённый для совместимости с lifecycle-контрактом. */
  pid: number;
}

interface LockFileOperations {
  open(path: string, flags: "wx"): Promise<FileHandle>;
  readFile(path: string): Promise<Buffer>;
  unlink(path: string): Promise<void>;
  createOwnerToken(): Buffer;
  /** Проверка живости процесса по PID; по умолчанию используется process.kill(pid, 0). */
  probeAlive?(pid: number): boolean | Promise<boolean>;
}

const defaultOperations: LockFileOperations = {
  open,
  readFile,
  unlink,
  createOwnerToken: () => randomBytes(16),
};

/** Разбирает v1 owner record вида `v1:<PID>:<hex token>\n`; иначе возвращает undefined. */
function parseV1OwnerRecord(raw: Buffer): { pid: number; token: string } | undefined {
  const text = raw.toString("utf8").replace(/\r?\n$/, "");
  const match = /^v1:(\d+):([0-9a-f]+)$/.exec(text);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, token: match[2]! };
}

/** Проверка существования процесса: ESRCH означает отсутствие, любые другие ошибки трактуются как живой процесс. */
function defaultProbeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

/** Формирует стандартную конфликтную ошибку lock-файла. */
function conflictError(lockPath: string, cause?: unknown): Error {
  return new Error(
    `Другой экземпляр Ebb Orchestrator уже использует каталог данных. Lock-файл: «${lockPath}». Проверьте, что ни один процесс Ebb Orchestrator не использует этот каталог; только после подтверждения вручную удалите lock-файл и повторите запуск.`,
    cause !== undefined ? { cause } : undefined,
  );
}

/**
 * Эксклюзивно владеет lock-файлом для одного процесса. При существующем пути
 * автоматически восстанавливается только заведомо устаревший v1 lock
 * (процесс-владелец мёртв); в остальных случаях путь остаётся конфликтом.
 * release удаляет файл только при совпадении полной owner record.
 */
export class SingleInstanceLock {
  private state: "idle" | "acquiring" | "held" | "releasing" = "idle";
  private ownerRecord: Buffer | undefined;
  private releasePromise: Promise<void> | undefined;
  private readonly probeAlive: (pid: number) => boolean | Promise<boolean>;

  /**
   * Создаёт lock для указанного пути. Операции можно подменить для детерминированной
   * проверки ошибок файловой системы; production использует Node fs и crypto.
   * Проверку живости процесса можно переопределить через `operations.probeAlive`.
   */
  constructor(
    private readonly lockPath: string,
    private readonly operations: LockFileOperations = defaultOperations,
  ) {
    this.probeAlive = operations.probeAlive ?? defaultProbeAlive;
  }

  /** Атомарно создаёт fresh lock; при существующем пути пытается восстановить устаревший v1 lock. */
  async acquire(): Promise<LockHandle> {
    if (this.state !== "idle") throw new Error(`Нельзя захватить lock в состоянии ${this.state}.`);
    this.state = "acquiring";
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await this.operations.open(this.lockPath, "wx");
      } catch (error) {
        if (isAlreadyExists(error)) {
          await this.tryRecoverStaleLock();
          try {
            handle = await this.operations.open(this.lockPath, "wx");
          } catch (retryError) {
            if (isAlreadyExists(retryError)) {
              throw conflictError(this.lockPath, retryError);
            }
            throw retryError;
          }
        } else {
          throw error;
        }
      }
      let token: Buffer;
      try {
        token = this.operations.createOwnerToken();
        const record = Buffer.from(`v1:${process.pid}:${token.toString("hex")}\n`, "utf8");
        await handle.writeFile(record);
        await handle.close();
        handle = undefined;
        this.ownerRecord = record;
      } catch {
        if (handle) await handle.close().catch(() => undefined);
        handle = undefined;
        this.state = "idle";
        throw new Error(`Не удалось записать lock-файл «${this.lockPath}». Проверьте, что ни один процесс Ebb Orchestrator не использует этот home; только после подтверждения отсутствия таких процессов вручную удалите lock-файл и повторите запуск.`);
      } finally {
        token = Buffer.alloc(0);
      }
      this.state = "held";
      return { pid: process.pid };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (this.state === "acquiring") this.state = "idle";
      throw error;
    }
  }

  /**
   * Пытается удалить устаревший lock-файл. Удаление допустимо только когда файл
   * является корректным v1 owner record и процесс-владелец заведомо мёртв
   * (probeAlive вернул false). Во всех остальных случаях — malformed/legacy формат,
   * живой владелец, ошибка чтения или изменение файла между проверкой и удалением —
   * метод выбрасывает конфликтную ошибку, сохраняя fail-closed поведение.
   */
  private async tryRecoverStaleLock(): Promise<void> {
    let contents: Buffer;
    try {
      contents = await this.operations.readFile(this.lockPath);
    } catch (error) {
      throw conflictError(this.lockPath, error);
    }
    const parsed = parseV1OwnerRecord(contents);
    if (!parsed) {
      throw conflictError(this.lockPath);
    }
    let alive: boolean;
    try {
      alive = await this.probeAlive(parsed.pid);
    } catch (error) {
      throw conflictError(this.lockPath, error);
    }
    if (alive) {
      throw conflictError(this.lockPath);
    }
    // Владелец мёртв: повторное чтение перед удалением защищает от гонки, когда
    // между проверкой живости и удалением появился новый законный владелец.
    let latest: Buffer;
    try {
      latest = await this.operations.readFile(this.lockPath);
    } catch (error) {
      throw conflictError(this.lockPath, error);
    }
    if (!latest.equals(contents)) {
      throw conflictError(this.lockPath);
    }
    try {
      await this.operations.unlink(this.lockPath);
    } catch (error) {
      throw conflictError(this.lockPath, error);
    }
    console.log(`[Ebb Orchestrator] Удалён устаревший lock-файл «${this.lockPath}» (процесс-владелец PID ${parsed.pid} не найден); запуск продолжается.`);
  }

  /** Удаляет lock только для полного owner record, удерживаемого этой instance. */
  async release(): Promise<void> {
    if (this.state === "releasing" && this.releasePromise) return this.releasePromise;
    if (this.state !== "held" || !this.ownerRecord) return;
    const record = this.ownerRecord;
    this.state = "releasing";
    this.releasePromise = (async () => {
      try {
        const current = await this.operations.readFile(this.lockPath);
        if (current.equals(record)) await this.operations.unlink(this.lockPath);
      } catch {
        // Ошибка чтения или удаления сохраняет неизвестное состояние lock-пути.
      } finally {
        this.ownerRecord = undefined;
        this.releasePromise = undefined;
        this.state = "idle";
      }
    })();
    return this.releasePromise;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
