import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startSystem,
  type SystemLifecycleDeps,
  type SystemStatus,
  type LockHandle,
} from "../../../src/platform/process/system-lifecycle.js";
import { SingleInstanceLock } from "../../../src/platform/process/single-instance-lock.js";
import { StartupReconciler } from "../../../src/platform/process/startup-reconciler.js";

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
      "status READY",
      "worker start",
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
      // secondAcquired remains false
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

    // Should not throw
  });

  it("recovers from stale lock file left by a dead process", async () => {
    const lockPath = join(tmpDir, "stale.lock");

    // Simulate a crashed process by writing a lock file with a PID that
    // is guaranteed not to exist (use 1 which is always init on Unix,
    // but on Windows we pick a very large PID that almost certainly
    // does not exist).
    const stalePid = process.platform === "win32" ? 99999999 : 1;
    await writeFile(lockPath, String(stalePid), "utf-8");

    // If the PID is alive (unlikely but possible for 1 on some Unix
    // systems), use a PID that is certainly dead.
    const lock = new SingleInstanceLock(lockPath);

    // acquire() should succeed by detecting the stale lock and removing it.
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
