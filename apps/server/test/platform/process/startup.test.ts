import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { ensureLocalUser } from "../../../src/platform/security/local-user-wizard.js";
import type { AuthRepository } from "../../../src/platform/security/auth-repository.js";
import {
  createStartupCleanup,
  createStartupSignalHandler,
  runStartupBoundary,
} from "../../../src/platform/process/startup-boundary.js";

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
      preflightRecovery: async () => { steps.push("process owner preflight"); },
      reconcileProjectConfig: async () => { steps.push("project config"); },
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
      "process owner preflight",
      "project config",
      "reconcile outbox",
      "reconcile jobs",
      "reconcile artifacts",
      "worker start",
      "status READY",
    ]);

    expect(currentStatus).toBe("READY");
  });

  it("fails closed at process-owner preflight before Project Config and later recovery", async () => {
    const calls: string[] = [];
    const status = new StatusTracker();
    const deps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      lockAlreadyAcquired: true,
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {} },
      status,
      preflightRecovery: async () => { calls.push("owner-preflight"); throw new Error("scope remains UNKNOWN"); },
      reconcileProjectConfig: async () => { calls.push("project-config"); },
      reconcileOutbox: async () => { calls.push("outbox"); },
      reconcileJobs: async () => { calls.push("jobs"); },
      reconcileArtifacts: async () => { calls.push("artifacts"); },
      additionalReconcilers: [async () => { calls.push("additional"); }],
      workers: [{ start: async () => { calls.push("worker"); }, stop: async () => {} }],
    } as SystemLifecycleDeps & { preflightRecovery: () => Promise<void>; reconcileProjectConfig: () => Promise<void> };

    await startSystem(deps);

    expect(calls).toEqual(["owner-preflight"]);
    expect(status.get()).toBe("DEGRADED");
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
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
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
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
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
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
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

  it("stops workers and refuses READY when startup is aborted during worker start", async () => {
    const controller = new AbortController();
    const statuses: SystemStatus[] = [];
    const stopped: string[] = [];
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      lockAlreadyAcquired: true,
      database: { open: async () => {}, close: async () => {} },
      migrator: { run: async () => {} },
      status: {
        get: () => statuses.at(-1) ?? "STARTING",
        set: async (status) => { statuses.push(status); },
      },
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [],
      signal: controller.signal,
      workers: [{
        start: async () => { controller.abort(new Error("startup interrupted")); },
        stop: async () => { stopped.push("worker"); },
      }],
    };

    await expect(startSystem(deps)).rejects.toThrow("startup interrupted");

    expect(stopped).toEqual(["worker"]);
    expect(statuses).toEqual(["RECOVERING", "DEGRADED"]);
  });

  it("keeps the server recoverable in degraded mode when startup reconciliation fails", async () => {
    const status = new StatusTracker();
    const workerStart = vi.fn(async () => {});
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {} },
      status,
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
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
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
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
    const ownerRecord = await readFile(join(tmpDir, "orchestrator.lock"), "utf-8").catch(() => "");
    expect(ownerRecord).toMatch(new RegExp(`^v1:${process.pid}:[0-9a-f]{32}\\n$`));
    await lock1.release();

    const lock2 = new SingleInstanceLock(lockPath);
    await lock2.acquire();
    await lock2.release();

  // Ошибка не должна выбрасываться.
  });

  it("fails closed without changing stale, malformed, or legacy lock files", async () => {
    const cases = ["12345", "{malformed", "v0:12345:legacy-token"];
    const backing = await import("node:fs/promises");
    let readCalls = 0;
    for (const [index, contents] of cases.entries()) {
      const lockPath = join(tmpDir, `existing-${index}.lock`);
      await writeFile(lockPath, contents, "utf-8");
      readCalls = 0;
      const lock = new SingleInstanceLock(lockPath, {
        open: (path, flags) => backing.open(path, flags),
        readFile: async (path) => { readCalls += 1; return backing.readFile(path); },
        unlink: (path) => backing.unlink(path),
        createOwnerToken: () => Buffer.alloc(16),
      });
      const killSpy = vi.spyOn(process, "kill");

      try {
        await expect(lock.acquire()).rejects.toThrow(lockPath);
        expect(readCalls).toBe(0);
        expect(await readFile(lockPath, "utf-8")).toBe(contents);
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    }
  });

  it("preserves a same-PID replacement with a different owner token on release", async () => {
    const lockPath = join(tmpDir, "replacement.lock");
    const lock = new SingleInstanceLock(lockPath);
    await lock.acquire();
    const replacement = `v1:${process.pid}:00000000000000000000000000000000\n`;
    await writeFile(lockPath, replacement, "utf-8");

    await lock.release();

    expect(await readFile(lockPath, "utf-8")).toBe(replacement);
  });

  it("allows exactly one of two independent contenders to acquire", async () => {
    const lockPath = join(tmpDir, "contended.lock");
    const contenders = [new SingleInstanceLock(lockPath), new SingleInstanceLock(lockPath)];
    const results = await Promise.allSettled(contenders.map((lock) => lock.acquire()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") await contenders[index]!.release();
    }
  });

  it("shares concurrent release and rejects acquire while release is pending", async () => {
    const lockPath = join(tmpDir, "serialized.lock");
    const lock = new SingleInstanceLock(lockPath);
    await lock.acquire();
    const releasing = lock.release();
    await expect(lock.acquire()).rejects.toThrow();
    const concurrentRelease = lock.release();
    await Promise.all([releasing, concurrentRelease]);
    expect(await readFile(lockPath, "utf-8").catch(() => "")).toBe("");
    await lock.acquire();
    await lock.release();
  });

  it("performs at most one unlink for concurrent release callers", async () => {
    const backing = await import("node:fs/promises");
    const lockPath = join(tmpDir, "single-unlink.lock");
    let readCalls = 0;
    let unlinkCalls = 0;
    let signalRead!: () => void;
    let allowRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { allowRead = resolve; });
    const operations = {
      open: (path: string, flags: "wx") => backing.open(path, flags),
      readFile: async (path: string) => {
        readCalls += 1;
        signalRead();
        await readGate;
        return backing.readFile(path);
      },
      unlink: async (path: string) => { unlinkCalls += 1; await backing.unlink(path); },
      createOwnerToken: () => Buffer.alloc(16, 9),
    };
    const lock = new SingleInstanceLock(lockPath, operations);
    await lock.acquire();
    const firstRelease = lock.release();
    await readStarted;
    const secondRelease = lock.release();
    expect(readCalls).toBe(1);
    allowRead();
    await Promise.all([firstRelease, secondRelease]);
    expect(unlinkCalls).toBe(1);
  });

  it("preserves a partial owner record after write failure and fails closed next time", async () => {
    const lockPath = join(tmpDir, "partial.lock");
    const backing = await import("node:fs/promises");
    let closed = false;
    const operations = {
      open: async (path: string, flags: "wx") => {
        const handle = await backing.open(path, flags);
        return {
          writeFile: async () => { await handle.writeFile("partial"); throw new Error("injected write failure"); },
          close: async () => { closed = true; await handle.close(); },
        } as unknown as Awaited<ReturnType<typeof backing.open>>;
      },
      readFile: async (path: string) => backing.readFile(path),
      unlink: async (path: string) => backing.unlink(path),
      createOwnerToken: () => Buffer.alloc(16, 1),
    };
    const lock = new SingleInstanceLock(lockPath, operations);
    await expect(lock.acquire()).rejects.toThrow(`Не удалось записать lock-файл «${lockPath}»`);
    expect(closed).toBe(true);
    expect(await readFile(lockPath, "utf-8")).toBe("partial");
    await expect(new SingleInstanceLock(lockPath).acquire()).rejects.toThrow(lockPath);
  });

  it("serializes a pending acquisition", async () => {
    const lock = new SingleInstanceLock(join(tmpDir, "pending.lock"));
    const acquire = lock.acquire();
    await expect(lock.acquire()).rejects.toThrow();
    await acquire;
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

  it("does not start workers when migrations fail", async () => {
    const workerStart = vi.fn(async () => {});
    const deps: SystemLifecycleDeps = {
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      lockAlreadyAcquired: true,
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => { throw new Error("migration failed"); } },
      status: { get: () => "STARTING", set: async () => {} },
      preflightRecovery: async () => {},
      reconcileProjectConfig: async () => {},
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [],
      workers: [{ start: workerStart, stop: async () => {} }],
    };

    await expect(startSystem(deps)).rejects.toThrow("migration failed");
    expect(workerStart).not.toHaveBeenCalled();
  });

  it("checks the singleton after migrations and skips the prompt on a second startup", async () => {
    const steps: string[] = ["migrations"];
    const hasLocalUser = vi.fn(async () => {
      steps.push("has local user");
      return true;
    });
    const repository = { hasLocalUser } as unknown as AuthRepository;

    await expect(ensureLocalUser(
      repository,
      {} as NodeJS.ReadStream,
      {} as NodeJS.WriteStream,
      { now: () => "2030-01-01T00:00:00.000Z" },
    )).resolves.toBe("EXISTING");

    expect(steps).toEqual(["migrations", "has local user"]);
    expect(hasLocalUser).toHaveBeenCalledOnce();
  });

  it("does not start workers or listen when the local-user wizard fails", async () => {
    const startWorkers = vi.fn(async () => {});
    const listen = vi.fn(async () => {});
    const wizardError = new Error("wizard failed");

    await expect(runStartupBoundary({
      ensureLocalUser: async () => { throw wizardError; },
      startSystem: async () => { await startWorkers(); },
      listen,
    })).rejects.toThrow(wizardError);

    expect(startWorkers).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("cleans up the database and instance lock when startup fails before READY", async () => {
    const events: string[] = [];
    const startupError = new Error("worker startup failed");
    const cleanupStartup = createStartupCleanup({
      database: { close: () => { events.push("close-database"); } },
      instanceLock: { release: async () => { events.push("release-lock"); } },
    });

    await expect(runStartupBoundary({
      ensureLocalUser: async () => { events.push("local-user"); },
      startSystem: async () => { events.push("start-system"); throw startupError; },
      listen: async () => { events.push("listen"); },
      cleanupStartup,
    })).rejects.toBe(startupError);

    expect(events).toEqual(["local-user", "start-system", "close-database", "release-lock"]);
    await cleanupStartup();
    expect(events).toEqual(["local-user", "start-system", "close-database", "release-lock"]);
  });

  it("cleans up and does not continue startup when a signal arrives before READY", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const readyShutdown = vi.fn();
    const handleSignal = createStartupSignalHandler({
      controller,
      isReady: () => false,
      onReadySignal: readyShutdown,
    });
    const cleanupStartup = createStartupCleanup({
      database: { close: () => { events.push("close-database"); } },
      instanceLock: { release: async () => { events.push("release-lock"); } },
    });

    await expect(runStartupBoundary({
      ensureLocalUser: async () => {
        events.push("local-user");
        handleSignal("SIGTERM");
      },
      startSystem: async () => { events.push("start-system"); },
      listen: async () => { events.push("listen"); },
      signal: controller.signal,
      cleanupStartup,
    })).rejects.toThrow("Startup interrupted by SIGTERM");

    expect(events).toEqual(["local-user", "close-database", "release-lock"]);
    expect(readyShutdown).not.toHaveBeenCalled();
  });

  it("closes a listener if a signal arrives while it is binding before READY", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    let isListening = false;
    const readyShutdown = vi.fn();
    const handleSignal = createStartupSignalHandler({
      controller,
      isReady: () => false,
      onReadySignal: readyShutdown,
    });
    const cleanupStartup = createStartupCleanup({
      server: {
        isListening: () => isListening,
        close: async () => { events.push("close-listener"); isListening = false; },
      },
      workers: [{ stop: async () => { events.push("stop-workers"); } }],
      database: { close: () => { events.push("close-database"); } },
      instanceLock: { release: async () => { events.push("release-lock"); } },
    });

    await expect(runStartupBoundary({
      ensureLocalUser: async () => { events.push("local-user"); },
      startSystem: async () => { events.push("start-system"); },
      listen: async () => {
        events.push("listen");
        isListening = true;
        handleSignal("SIGINT");
      },
      signal: controller.signal,
      cleanupStartup,
    })).rejects.toThrow("Startup interrupted by SIGINT");

    expect(events).toEqual(["local-user", "start-system", "listen", "close-listener", "stop-workers", "close-database", "release-lock"]);
    expect(isListening).toBe(false);
    expect(readyShutdown).not.toHaveBeenCalled();
  });

  it("routes lifecycle signals to graceful shutdown after READY", () => {
    const controller = new AbortController();
    const onReadySignal = vi.fn();
    const handleSignal = createStartupSignalHandler({
      controller,
      isReady: () => true,
      onReadySignal,
    });

    handleSignal("SIGTERM");

    expect(controller.signal.aborted).toBe(false);
    expect(onReadySignal).toHaveBeenCalledOnce();
    expect(onReadySignal).toHaveBeenCalledWith("SIGTERM");
  });

  it("attempts lock release when database close fails and shares the cleanup result", async () => {
    const events: string[] = [];
    const cleanupStartup = createStartupCleanup({
      database: { close: () => { events.push("close-database"); throw new Error("close failed"); } },
      instanceLock: { release: async () => { events.push("release-lock"); } },
    });

    const first = cleanupStartup();
    const second = cleanupStartup();
    await expect(first).rejects.toThrow("Startup resource cleanup failed");
    await expect(second).rejects.toThrow("Startup resource cleanup failed");
    expect(events).toEqual(["close-database", "release-lock"]);
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
