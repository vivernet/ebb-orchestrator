/**
 * Файловая блокировка единственного экземпляра.
 *
 * Использует lock-файл с текущим PID, чтобы не допустить запуска дублирующих
 * backend-процессов. При захвате проверяет, указывает ли существующий lock-файл
 * на работающий процесс. Если процесс завершён, устаревший lock перезаписывается.
 * Если процесс работает, захват завершается ошибкой.
 *
 * Вызов `release()` удаляет lock-файл.
 */

import { open, readFile, unlink, writeFile } from "node:fs/promises";

export interface LockHandle {
  /** PID, записанный в lock-файле. */
  pid: number;
}

/**
 * Предоставляет публичный контракт модуля single-instance-lock для взаимодействия слоёв приложения.
 */
export class SingleInstanceLock {
  private held = false;

  constructor(private readonly lockPath: string) {}

  /**
   * Пытается захватить single-instance lock.
   *
   * - Если lock-файла нет, создаёт его с текущим PID — успех.
   * - Если lock-файл есть и его PID ещё работает — выбрасывает ошибку.
   * - Если lock-файл есть, но его PID завершён — перезаписывает файл — успех.
   */
  async acquire(): Promise<LockHandle> {
    // Пытается прочитать существующий lock-файл.
    let existing: LockHandle | undefined;
    try {
      const content = await readFile(this.lockPath, "utf-8");
      const pid = Number(content.trim());
      if (Number.isFinite(pid) && pid > 0) {
        existing = { pid };
      }
    } catch {
      // Lock-файл отсутствует, можно продолжить.
    }

    if (existing) {
      if (await this.isProcessAlive(existing.pid)) {
        throw new Error(
          `Cannot acquire lock: another instance is running (PID ${existing.pid}). ` +
            `Lock file: ${this.lockPath}`,
        );
      }
      // Lock-файл устарел, удаляем его перед созданием нового.
      await unlink(this.lockPath).catch(() => {});
    }

    const handle = await open(this.lockPath, "wx");
    try {
      await writeFile(handle, String(process.pid));
    } finally {
      await handle.close();
    }

    this.held = true;
    return { pid: process.pid };
  }

  /**
   * Освобождает single-instance lock удалением lock-файла.
   *
   * Удаляет файл только если им владеет текущий процесс.
   */
  async release(): Promise<void> {
    if (!this.held) return;

    try {
      // Проверяет владение lock перед удалением.
      const content = await readFile(this.lockPath, "utf-8");
      const pid = Number(content.trim());
      if (pid === process.pid) {
        await unlink(this.lockPath);
      }
    } catch {
      // Lock-файл уже удалён, ничего не делает.
    }

    this.held = false;
  }

  /**
   * Проверяет, работает ли процесс с указанным PID.
   * Использует `process.kill(pid, 0)`: сигнал не отправляется, проверяется только
   * существование процесса. На Unix PID 1 (init) считается устаревшим lock'ом.
   */
  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      // На Unix PID 1 — это init, который не может быть экземпляром нашего приложения.
      return !(process.platform !== "win32" && pid === 1);
    } catch {
      return false;
    }
  }
}
