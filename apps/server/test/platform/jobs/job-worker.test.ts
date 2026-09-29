import { describe, expect, it, vi } from "vitest";
import { JobWorker } from "../../../src/platform/jobs/job-worker.js";

describe("JobWorker", () => {
  it("обрабатывает только bounded batch и продолжает polling", async () => {
    const runOnce = vi.fn()
      .mockResolvedValueOnce({ claimed: 1, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ claimed: 1, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ claimed: 0, succeeded: 0, failed: 0 });
    const worker = new JobWorker({ runOnce }, 2, 60_000);

    await worker.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
    expect(runOnce).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("does not claim work until after start returns, allowing lifecycle to publish READY", async () => {
    let ready = false;
    const runOnce = vi.fn(async () => {
      expect(ready).toBe(true);
      return { claimed: 0, succeeded: 0, failed: 0 };
    });
    const worker = new JobWorker({ runOnce }, 1, 60_000);

    await worker.start();
    expect(runOnce).not.toHaveBeenCalled();
    ready = true;
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    await worker.stop();
  });

  it("shutdown before the first poll cancels startup without claiming a job", async () => {
    const runOnce = vi.fn();
    const worker = new JobWorker({ runOnce }, 1, 60_000);

    await worker.start();
    await worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runOnce).not.toHaveBeenCalled();
  });

  it("stop ждёт завершения in-flight job и не планирует новый tick", async () => {
    let resolveJob: (() => void) | undefined;
    let executionSignal: AbortSignal | undefined;
    const runOnce = vi.fn().mockImplementation((_now: Date, signal?: AbortSignal) => new Promise((resolve) => {
      executionSignal = signal;
      markRunStarted();
      resolveJob = () => resolve({ claimed: 1, succeeded: 1, failed: 0 });
    }));
    const worker = new JobWorker({ runOnce }, 1, 60_000);

    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
    const startPromise = worker.start();
    await runStarted;
    const stopPromise = worker.stop();
    let stopped = false;
    void stopPromise.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(executionSignal?.aborted).toBe(true);

    resolveJob!();
    await Promise.all([startPromise, stopPromise]);
    expect(stopped).toBe(true);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("ошибка runner не оставляет worker без следующего tick", async () => {
    const runOnce = vi.fn()
      .mockRejectedValueOnce(new Error("temporary db error"))
      .mockResolvedValueOnce({ claimed: 0, succeeded: 0, failed: 0 });
    const worker = new JobWorker({ runOnce }, 1, 60_000);

    await worker.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
    expect(runOnce).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("отклоняет некорректные bounds", () => {
    const runner = { runOnce: vi.fn() };
    expect(() => new JobWorker(runner, 0)).toThrow("maxJobsPerTick");
    expect(() => new JobWorker(runner, 1, -1)).toThrow("intervalMs");
  });
});
