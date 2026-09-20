import type { BackgroundWorker } from "../process/system-lifecycle.js";

export interface OutboxWorkerDispatcher {
  dispatchBatch(limit: number): Promise<number>;
}

/**
 * Постоянно дренирует transactional outbox после перехода системы в READY.
 *
 * Worker выполняет только один drain одновременно, не создаёт новые claims после
 * остановки и ожидает завершения текущего drain перед возвратом из `stop`.
 */
export class OutboxWorker implements BackgroundWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly dispatcher: OutboxWorkerDispatcher,
    private readonly batchSize = 100,
    private readonly intervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    await this.drain();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  private async drain(): Promise<void> {
    if (!this.running || this.stopping || this.inFlight) return;
    const current = (async () => {
      try {
        await this.dispatcher.dispatchBatch(this.batchSize);
      } catch {
        // Следующий цикл повторит попытку; событие остаётся pending в outbox.
      } finally {
        this.inFlight = undefined;
        if (this.running && !this.stopping) {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, this.intervalMs);
          this.timer.unref?.();
        }
      }
    })();
    this.inFlight = current;
    await current;
  }
}
