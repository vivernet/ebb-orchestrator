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
    expect(runOnce).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("stop ждёт завершения in-flight job и не планирует новый tick", async () => {
    let resolveJob: (() => void) | undefined;
    const runOnce = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveJob = () => resolve({ claimed: 1, succeeded: 1, failed: 0 });
    }));
    const worker = new JobWorker({ runOnce }, 1, 0);

    const startPromise = worker.start();
    await Promise.resolve();
    const stopPromise = worker.stop();
    let stopped = false;
    void stopPromise.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveJob!();
    await Promise.all([startPromise, stopPromise]);
    expect(stopped).toBe(true);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("ошибка runner не оставляет worker без следующего tick", async () => {
    const runOnce = vi.fn()
      .mockRejectedValueOnce(new Error("temporary db error"))
      .mockResolvedValueOnce({ claimed: 0, succeeded: 0, failed: 0 });
    const worker = new JobWorker({ runOnce }, 1, 0);

    await worker.start();
    expect(runOnce).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("отклоняет некорректные bounds", () => {
    const runner = { runOnce: vi.fn() };
    expect(() => new JobWorker(runner, 0)).toThrow("maxJobsPerTick");
    expect(() => new JobWorker(runner, 1, -1)).toThrow("intervalMs");
  });
});
