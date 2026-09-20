import { describe, expect, it, vi } from "vitest";
import { OutboxWorker } from "../../../src/platform/events/outbox-worker.js";

describe("OutboxWorker", () => {
  it("drains immediately and never overlaps drains", async () => {
    let release: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let active = 0;
    let maxActive = 0;
    const dispatcher = {
      dispatchBatch: vi.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        resolveStarted?.();
        await new Promise<void>((resolve) => { release = resolve; });
        active--;
        return 1;
      }),
    };
    const worker = new OutboxWorker(dispatcher, 10, 1);

    const start = worker.start();
    await started;
    release?.();
    await start;
    await worker.stop();

    expect(dispatcher.dispatchBatch).toHaveBeenCalledWith(10);
    expect(maxActive).toBe(1);
  });

  it("retries after a dispatcher failure", async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = { dispatchBatch: vi.fn()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce(1) };
      const worker = new OutboxWorker(dispatcher, 5, 25);
      await worker.start();
      await vi.advanceTimersByTimeAsync(25);
      expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
