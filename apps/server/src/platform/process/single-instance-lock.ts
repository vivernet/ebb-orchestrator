/**
 * File-based single-instance lock.
 *
 * Uses a lock file with the current PID to prevent duplicate backend
 * processes.  On acquire, the lock checks whether an existing lock
 * file points to a still-running process.  If the process is dead the
 * stale lock is overwritten.  If the process is alive, the acquisition
 * throws.
 *
 * Calling `release()` removes the lock file.
 */

import { open, readFile, unlink, writeFile } from "node:fs/promises";

export interface LockHandle {
  /** PID recorded in the lock file. */
  pid: number;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class SingleInstanceLock {
  private held = false;

  constructor(private readonly lockPath: string) {}

  /**
   * Attempt to acquire the single-instance lock.
   *
   * - If no lock file exists, create it with the current PID → success.
   * - If a lock file exists and its PID is still running → throw.
   * - If a lock file exists and its PID is dead → overwrite → success.
   */
  async acquire(): Promise<LockHandle> {
    // Try to read an existing lock file.
    let existing: LockHandle | undefined;
    try {
      const content = await readFile(this.lockPath, "utf-8");
      const pid = Number(content.trim());
      if (Number.isFinite(pid) && pid > 0) {
        existing = { pid };
      }
    } catch {
      // No lock file – we can proceed.
    }

    if (existing) {
      if (this.isProcessAlive(existing.pid)) {
        throw new Error(
          `Cannot acquire lock: another instance is running (PID ${existing.pid}). ` +
            `Lock file: ${this.lockPath}`,
        );
      }
      // Stale lock – delete it before re-creating.
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
   * Release the single-instance lock by removing the lock file.
   *
   * Only removes the file if the current process owns it.
   */
  async release(): Promise<void> {
    if (!this.held) return;

    try {
      // Verify we still own the lock before deleting.
      const content = await readFile(this.lockPath, "utf-8");
      const pid = Number(content.trim());
      if (pid === process.pid) {
        await unlink(this.lockPath);
      }
    } catch {
      // Lock file already gone – ignore.
    }

    this.held = false;
  }

  /**
   * Check whether a process with the given PID is still running.
   * Uses `process.kill(pid, 0)` which sends no signal but checks
   * whether the process exists.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
