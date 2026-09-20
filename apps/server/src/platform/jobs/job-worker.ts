import type { BackgroundWorker } from "../process/system-lifecycle.js";
import type { JobRunner } from "./job-runner.js";

/**
 * Постоянно обрабатывает ограниченную пачку фоновых jobs.
 *
 * Worker не регистрирует handlers самостоятельно: registry передаётся в
 * {@link JobRunner}. Поэтому неизвестный тип проходит через существующую
 * deterministic-политику JobRunner и не может выполнить произвольный код.
 */
export class JobWorker implements BackgroundWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly runner: Pick<JobRunner, "runOnce">,
    private readonly maxJobsPerTick = 10,
    private readonly intervalMs = 1_000,
  ) {
    if (!Number.isInteger(maxJobsPerTick) || maxJobsPerTick < 1) {
      throw new Error("maxJobsPerTick must be a positive integer");
    }
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error("intervalMs must be a non-negative finite number");
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    await this.poll();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.stopping || this.inFlight) return;
    const current = (async () => {
      try {
        for (let index = 0; index < this.maxJobsPerTick; index += 1) {
          if (!this.running || this.stopping) break;
          const result = await this.runner.runOnce(new Date());
          if (result.claimed === 0) break;
        }
      } catch {
        // Ошибка инфраструктуры не должна остановить worker навсегда.
        // Следующий bounded tick повторит claim; уже claimed job восстановится
        // по lease после истечения срока, если сбой произошёл до его commit.
      } finally {
        this.inFlight = undefined;
        if (this.running && !this.stopping) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.poll();
          }, this.intervalMs);
          this.timer.unref?.();
        }
      }
    })();
    this.inFlight = current;
    await current;
  }
}
