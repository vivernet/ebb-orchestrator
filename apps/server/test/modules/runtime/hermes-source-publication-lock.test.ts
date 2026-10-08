import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
type AcquirePublicationLock = typeof import("../../../src/modules/runtime/hermes/hermes-source-publication-lock.js")["acquireHermesSourcePublicationLock"];

const CACHE_ROOT = resolve("private", "source-cache");

const gate = vi.hoisted(() => ({ invocation: vi.fn(), spawn: vi.fn() }));
vi.mock("../../../src/platform/process/windows-native-helper-launcher.js", () => ({ createWindowsNativeHelperInvocation: gate.invocation }));
vi.mock("node:child_process", () => ({ spawn: gate.spawn }));

let originalPlatform: PropertyDescriptor | undefined;
let child: FixtureChild;
let acquireHermesSourcePublicationLock: AcquirePublicationLock;

class FixtureChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  input = "";
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => { this.input += chunk.toString(); });
    this.stdin.once("finish", () => this.stop(0));
    this.stdin.once("close", () => this.stop(0));
  }
  stop(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("close", code);
  }
  kill() { this.stop(137); return true; }
}

beforeEach(async () => {
  vi.resetModules();
  ({ acquireHermesSourcePublicationLock } = await import("../../../src/modules/runtime/hermes/hermes-source-publication-lock.js"));
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  child = new FixtureChild();
  gate.invocation.mockResolvedValue({ file: "verified-gate.exe", args: ["bounded-gate"], env: { SystemRoot: "C:\\Windows" } });
  gate.spawn.mockImplementation(() => child);
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  child.stop(0);
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../../src/platform/process/windows-native-helper-launcher.js");
  vi.resetModules();
});

describe("verified Hermes source publication lease adapter", () => {
  it("waits for exact bounded READY and explicitly releases the same Node owner nonce", async () => {
    const pending = acquireHermesSourcePublicationLock({ cacheRoot: CACHE_ROOT });
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    child.stdout.write("SOURCE_CACHE_");
    child.stdout.write("LOCK_READY\r\n");
    const lease = await pending;
    lease.assertHeld();
    expect(gate.invocation.mock.calls[0]?.[1]).toBe("hermesProfilePath");
    const argv = gate.invocation.mock.calls[0]?.[2] as string[];
    expect(argv.slice(0, 3)).toEqual(["source-cache-lock", CACHE_ROOT, String(process.pid)]);
    expect(argv[3]).toMatch(/^[0-9a-f-]{36}$/u);
    const released = lease.release();
    expect(lease.release()).toBe(released);
    await released;
    expect(child.input).toBe(`RELEASE ${argv[3]}\n`);
    expect(() => lease.assertHeld()).toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
    expect(gate.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true, env: { SystemRoot: "C:\\Windows" } });
  });

  it.each(["wrong", "overflow", "stderr", "closed"])("fails closed on %s before READY", async (fault) => {
    const pending = acquireHermesSourcePublicationLock({ cacheRoot: CACHE_ROOT });
    const rejected = expect(pending).rejects.toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    if (fault === "wrong") child.stdout.write("UNTRUSTED_READY\n");
    if (fault === "overflow") child.stdout.write("x".repeat(1025));
    if (fault === "stderr") child.stderr.write("fixture error");
    if (fault === "closed") child.stop(10);
    await rejected;
    expect(child.exitCode).not.toBeNull();
  });

  it("cancels only acquisition and awaits helper EOF shutdown", async () => {
    const controller = new AbortController();
    const pending = acquireHermesSourcePublicationLock({ cacheRoot: CACHE_ROOT, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(child.stdin.destroyed).toBe(true);
    expect(child.exitCode).toBe(0);
  });

  it("detects helper death while held and never reports successful release", async () => {
    const pending = acquireHermesSourcePublicationLock({ cacheRoot: CACHE_ROOT });
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    child.stdout.write("SOURCE_CACHE_LOCK_READY\n");
    const lease = await pending;
    child.stop(137);
    expect(() => lease.assertHeld()).toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
    await expect(lease.release()).rejects.toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
  });

  it("fails closed before spawn when the parent-code helper integrity gate is unavailable", async () => {
    gate.invocation.mockRejectedValueOnce(new Error("missing trusted anchor"));
    await expect(acquireHermesSourcePublicationLock({ cacheRoot: CACHE_ROOT }))
      .rejects.toThrow("HERMES_SOURCE_PUBLICATION_LOCK_UNAVAILABLE");
    expect(gate.spawn).not.toHaveBeenCalled();
  });
});
