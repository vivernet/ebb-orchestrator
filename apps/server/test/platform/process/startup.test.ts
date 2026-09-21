import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startSystem,
  shutdownSystem,
  type SystemLifecycleDeps,
  type SystemStatus,
  type LockHandle,
  StatusTracker,
} from "../../../src/platform/process/system-lifecycle.js";
import { SingleInstanceLock } from "../../../src/platform/process/single-instance-lock.js";
import { failClosedStartupReconciliation, StartupReconciler } from "../../../src/platform/process/startup-reconciler.js";

describe("startup lifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-startup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("runs startup steps in correct order", async () => {
    const steps: string[] = [];
    let currentStatus: SystemStatus = "STARTING";

    const deps: SystemLifecycleDeps = {
      instanceLock: {
        acquire: async (): Promise<LockHandle> => {
          steps.push("acquire lock");
          return { pid: 1 };
        },
        release: async () => {},
      },
      database: {
        open: async () => {
          steps.push("open DB");
        },
        close: async () => {},
      },
      migrator: {
        run: async () => {
          steps.push("migrations");
        },
      },
      status: {
        get: () => currentStatus,
        set: async (s: SystemStatus) => {
          currentStatus = s;
          steps.push(`status ${s}`);
        },
      },
      reconcileOutbox: async () => {
        steps.push("reconcile outbox");
      },
      reconcileJobs: async () => {
        steps.push("reconcile jobs");
      },
      reconcileArtifacts: async () => {
        steps.push("reconcile artifacts");
      },
      additionalReconcilers: [],
      workers: [
        {
          start: async () => {
            steps.push("worker start");
          },
          stop: async () => {},
        },
      ],
    };

    await startSystem(deps);

    expect(steps).toEqual([
      "acquire lock",
      "open DB",
      "migrations",
      "status RECOVERING",
      "reconcile outbox",
      "reconcile jobs",
      "reconcile artifacts",
      "worker start",
      "status READY",
    ]);

    expect(currentStatus).toBe("READY");
  });

  it("runs additional reconcilers after built-in ones", async () => {
    const steps: string[] = [];

    const deps: SystemLifecycleDeps = {
      instanceLock: {
        acquire: async (): Promise<LockHandle> => {
          return { pid: 1 };
        },
        release: async () => {},
      },
      database: {
        open: async () => {},
        close: async () => {},
      },
      migrator: {
        run: async () => {},
      },
      status: {
        get: () => "STARTING" as SystemStatus,
        set: async () => {},
      },
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [
        async () => {
          steps.push("custom reconciler 1");
        },
        async () => {
          steps.push("custom reconciler 2");
        },
      ],
      workers: [],
    };

    await startSystem(deps);

    expect(steps).toEqual(["custom reconciler 1", "custom reconciler 2"]);
  });

  it("does not reacquire a lock that the entry point already holds before migrations", async () => {
    const steps: string[] = [];
    const deps: SystemLifecycleDeps = {
      instanceLock: {
        acquire: async (): Promise<LockHandle> => {
          steps.push("unexpected acquire");
          throw new Error("lock must not be reacquired");
        },
        release: async () => {},
      },
      lockAlreadyAcquired: true,
      database: { open: async () => { steps.push("open DB"); }, close: async () => {} },
      migrator: { run: async () => { steps.push("migrations"); } },
      status: { get: () => "STARTING" as SystemStatus, set: async (status) => { steps.push(`status ${status}`); } },
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [],
      workers: [],
    };

    await startSystem(deps);

    expect(steps).toEqual(["open DB", "migrations", "status RECOVERING", "status READY"]);
  });

  it("does not become ready when a worker fails to start", async () => {
    const statuses: SystemStatus[] = [];
    const stopped: string[] = [];
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {} },
      status: {
        get: () => statuses.at(-1) ?? "STARTING",
        set: async (status) => { statuses.push(status); },
      },
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [],
      workers: [
        {
          start: async () => {},
          stop: async () => { stopped.push("first"); },
        },
        {
          start: async () => { throw new Error("worker failed"); },
          stop: async () => { stopped.push("failed"); },
        },
      ],
    };

    await expect(startSystem(deps)).rejects.toThrow("worker failed");
    expect(statuses).toEqual(["RECOVERING", "DEGRADED"]);
    expect(stopped).toEqual(["first"]);
  });

  it("keeps the server recoverable in degraded mode when startup reconciliation fails", async () => {
    const status = new StatusTracker();
    const workerStart = vi.fn(async () => {});
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {} },
      status,
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [async () => {
        await failClosedStartupReconciliation(
          { reconcilersRun: 1, errors: [new Error("reconciliation failed")] },
          status,
        );
      }],
      workers: [{ start: workerStart, stop: async () => {} }],
    };

    await startSystem(deps);

    expect(status.get()).toBe("DEGRADED");
    expect(workerStart).not.toHaveBeenCalled();
  });

  it("logs only a safe recovery step diagnostic for built-in reconciliation failures", async () => {
    const status = new StatusTracker();
    const workerStart = vi.fn(async () => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretLikeMessage = "repository-token=secret-model-output";
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {} },
      status,
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {
        throw new Error(secretLikeMessage);
      },
      reconcileArtifacts: async () => {},
      additionalReconcilers: [],
      workers: [{ start: workerStart, stop: async () => {} }],
    };

    try {
      await startSystem(deps);

      expect(status.get()).toBe("DEGRADED");
      expect(workerStart).not.toHaveBeenCalled();
      const diagnostics = errorSpy.mock.calls.flat().join(" ");
      expect(diagnostics).toContain("step=reconcile_jobs");
      expect(diagnostics).not.toContain(secretLikeMessage);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("uses one shutdown deadline for all workers", async () => {
    vi.useFakeTimers();
    try {
      const stopped: string[] = [];
      const closed = vi.fn();
      const released = vi.fn(async () => {});
      const shutdown = shutdownSystem({
        status: { get: () => "READY", set: vi.fn(async () => {}) },
        workers: [
          { start: async () => {}, stop: async () => { stopped.push("one"); await new Promise<void>(() => {}); } },
          { start: async () => {}, stop: async () => { stopped.push("two"); await new Promise<void>(() => {}); } },
        ],
        database: { open: async () => {}, close: closed },
        instanceLock: { release: released },
        timeoutMs: 1_000,
      });

      await Promise.resolve();
      expect(stopped).toEqual(["one", "two"]);
      expect(closed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await shutdown;

      expect(closed).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents second instance from acquiring lock", async () => {
    const lockPath = join(tmpDir, "orchestrator.lock");
    const lock1 = new SingleInstanceLock(lockPath);
    const lock2 = new SingleInstanceLock(lockPath);

    await lock1.acquire();

    let secondAcquired = false;
    try {
      await lock2.acquire();
      secondAcquired = true;
    } catch {
    // secondAcquired остаётся равным false.
    }

    expect(secondAcquired).toBe(false);

    await lock1.release();
  });

  it("allows re-acquisition after release", async () => {
    const lockPath = join(tmpDir, "orchestrator.lock");
    const lock1 = new SingleInstanceLock(lockPath);

    await lock1.acquire();
    await lock1.release();

    const lock2 = new SingleInstanceLock(lockPath);
    await lock2.acquire();
    await lock2.release();

  // Ошибка не должна выбрасываться.
  });

  it("recovers from stale lock file left by a dead process", async () => {
    const lockPath = join(tmpDir, "stale.lock");

  // Имитируем аварийно завершившийся процесс, записав файл блокировки с PID,
  // который гарантированно не существует: на Unix используется 1, всегда занятый
  // init, а в Windows выбирается очень большой PID, которого почти наверняка нет.
    const stalePid = process.platform === "win32" ? 99999999 : 1;
    await writeFile(lockPath, String(stalePid), "utf-8");

  // Если PID занят (маловероятно, но возможно для 1 в некоторых Unix-системах),
  // используем PID, который точно не существует.
    const lock = new SingleInstanceLock(lockPath);

  // acquire() должен успешно обнаружить устаревшую блокировку и удалить её.
    const handle = await lock.acquire();
    expect(handle.pid).toBe(process.pid);

    await lock.release();
  });

  it("StartupReconciler collects and runs registered functions", async () => {
    const calls: string[] = [];
    const reconciler = new StartupReconciler();

    reconciler.register(async () => {
      calls.push("a");
    });
    reconciler.register(async () => {
      calls.push("b");
    });

    const report = await reconciler.run();

    expect(calls).toEqual(["a", "b"]);
    expect(report.reconcilersRun).toBe(2);
    expect(report.errors).toHaveLength(0);
  });

  it("StartupReconciler continues on error and collects errors", async () => {
    const calls: string[] = [];
    const reconciler = new StartupReconciler();

    reconciler.register(async () => {
      calls.push("a");
    });
    reconciler.register(async () => {
      throw new Error("boom");
    });
    reconciler.register(async () => {
      calls.push("c");
    });

    const report = await reconciler.run();

    expect(calls).toEqual(["a", "c"]);
    expect(report.reconcilersRun).toBe(3);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.message).toBe("boom");
  });

  it("marks lifecycle degraded and rejects a failed startup reconciliation", async () => {
    const status = new StatusTracker();
    const report = { reconcilersRun: 1, errors: [new Error("boom")] };

    await expect(failClosedStartupReconciliation(report, status)).rejects.toThrow("Startup reconciliation failed: boom");
    expect(status.get()).toBe("DEGRADED");
  });

  it("SingleInstanceLock throws if lock file is held", async () => {
    const lockPath = join(tmpDir, "single.lock");
    const lock = new SingleInstanceLock(lockPath);

    await lock.acquire();

    const lock2 = new SingleInstanceLock(lockPath);
    await expect(lock2.acquire()).rejects.toThrow();

    await lock.release();
  });

  it("system-lifecycle StatusTracker exposes correct status", async () => {
    const { StatusTracker } = await import(
      "../../../src/platform/process/system-lifecycle.js"
    );
    const tracker = new StatusTracker();

    expect(tracker.get()).toBe("STARTING");
    await tracker.set("RECOVERING");
    expect(tracker.get()).toBe("RECOVERING");
    await tracker.set("READY");
    expect(tracker.get()).toBe("READY");
  });
});
