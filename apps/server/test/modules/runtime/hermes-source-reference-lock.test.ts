import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

const CACHE_ROOT = resolve("private", "source-cache");

const gate = vi.hoisted(() => ({ invocation: vi.fn(), spawn: vi.fn() }));
vi.mock("../../../src/platform/process/windows-native-helper-launcher.js", () => ({ createWindowsNativeHelperInvocation: gate.invocation }));
vi.mock("node:child_process", () => ({ spawn: gate.spawn }));

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
  }
  stop(code: number) { if (this.exitCode === null) { this.exitCode = code; this.emit("close", code); } }
  kill() { this.stop(137); return true; }
}

let originalPlatform: PropertyDescriptor | undefined;
let child: FixtureChild;
let acquire: typeof import("../../../src/modules/runtime/hermes/hermes-source-reference-lock.js").acquireHermesSourceReferenceLock;

beforeEach(async () => {
  vi.resetModules();
  ({ acquireHermesSourceReferenceLock: acquire } = await import("../../../src/modules/runtime/hermes/hermes-source-reference-lock.js"));
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

describe("Hermes source reference lock adapter", () => {
  it.each(["shared", "exclusive"] as const)("holds and explicitly releases a %s lease", async (mode) => {
    const pending = acquire({ cacheRoot: CACHE_ROOT, mode });
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    const argv = gate.invocation.mock.calls[0]?.[2] as string[];
    expect(argv).toHaveLength(4);
    expect(argv.slice(0, 3)).toEqual(["source-cache-reference-lock", CACHE_ROOT, mode]);
    expect(argv[3]).toMatch(/^[0-9a-f-]{36}$/u);
    child.stdout.write("SOURCE_CACHE_LOCK_READY\n");
    const lease = await pending;
    lease.assertHeld();
    const released = lease.release();
    expect(lease.release()).toBe(released);
    await released;
    expect(child.input).toBe(`RELEASE ${argv[3]}\n`);
    expect(() => lease.assertHeld()).toThrow("HERMES_SOURCE_REFERENCE_LOCK_UNAVAILABLE");
    expect(gate.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true });
  });

  it("fails closed on malformed helper readiness", async () => {
    const pending = acquire({ cacheRoot: CACHE_ROOT, mode: "exclusive" });
    const rejected = expect(pending).rejects.toThrow("HERMES_SOURCE_REFERENCE_LOCK_UNAVAILABLE");
    await vi.waitFor(() => expect(gate.spawn).toHaveBeenCalledOnce());
    child.stdout.write("UNTRUSTED_READY\n");
    await rejected;
    expect(child.exitCode).not.toBeNull();
  });
});
