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
}

const defaultOperations: LockFileOperations = {
  open,
  readFile,
  unlink,
  createOwnerToken: () => randomBytes(16),
};

/**
 * Эксклюзивно владеет lock-файлом для одного процесса. Существующий путь всегда
 * является конфликтом; release удаляет файл только при совпадении полной owner record.
 */
export class SingleInstanceLock {
  private state: "idle" | "acquiring" | "held" | "releasing" = "idle";
  private ownerRecord: Buffer | undefined;
  private releasePromise: Promise<void> | undefined;

  /**
   * Создаёт lock для указанного пути. Операции можно подменить для детерминированной
   * проверки ошибок файловой системы; production использует Node fs и crypto.
   */
  constructor(
    private readonly lockPath: string,
    private readonly operations: LockFileOperations = defaultOperations,
  ) {}

  /** Атомарно создаёт fresh lock; существующий путь не читается и не меняется. */
  async acquire(): Promise<LockHandle> {
    if (this.state !== "idle") throw new Error(`Нельзя захватить lock в состоянии ${this.state}.`);
    this.state = "acquiring";
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await this.operations.open(this.lockPath, "wx");
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error(`Другой экземпляр Ebb Orchestrator уже использует каталог данных. Lock-файл: «${this.lockPath}». Проверьте, что ни один процесс Ebb Orchestrator не использует этот каталог; только после подтверждения вручную удалите lock-файл и повторите запуск.`, { cause: error });
        }
        throw error;
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
