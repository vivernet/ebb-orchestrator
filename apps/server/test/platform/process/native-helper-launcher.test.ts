import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const seam = vi.hoisted(() => ({ open: vi.fn(), lstat: vi.fn(), digest: vi.fn(), spawn: vi.fn() }));
let nativeHelperLauncher: typeof import("../../../src/platform/process/native-helper-launcher.js");

const bytes = Buffer.from("pinned native fixture");
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const handles: Array<ReturnType<typeof handle>> = [];
function stats(index: number, file = false) {
  return { dev: 1n, ino: BigInt(index), size: BigInt(file ? bytes.length : 0),
    mode: file ? 0o100777n : 0o40777n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
}
function handle(index: number, file = false) {
  return { fd: 10 + index, stat: vi.fn().mockResolvedValue(stats(index, file)),
    read: vi.fn(async (buffer: Buffer, offset: number, _length: number, position: number) => {
      if (position >= bytes.length) return { bytesRead: 0 };
      bytes.copy(buffer, offset, position); return { bytesRead: bytes.length - position };
    }),
    close: vi.fn().mockResolvedValue(undefined) };
}
beforeEach(async () => {
  // Server Vitest runs with isolate:false. Scope these mocks to this suite and import the
  // subject only after resetting the module registry so its dependencies cannot leak to peers.
  vi.resetModules();
  vi.doMock("node:fs", () => ({ constants: { O_RDONLY: 0, O_NOFOLLOW: 131072, O_DIRECTORY: 65536, O_NONBLOCK: 2048 } }));
  vi.doMock("node:fs/promises", () => ({ open: seam.open, lstat: seam.lstat }));
  vi.doMock("node:child_process", () => ({ spawn: seam.spawn }));
  vi.doMock("../../../src/platform/process/native-helper-integrity.js", () => ({ getNativeHelperIntegrityDigest: seam.digest }));
  nativeHelperLauncher = await import("../../../src/platform/process/native-helper-launcher.js");
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  handles.splice(0, handles.length, handle(0), handle(1), handle(2, true));
  seam.open.mockImplementation(async () => handles[seam.open.mock.calls.length - 1]);
  seam.lstat.mockImplementation(async (name: string) => stats(name.endsWith("helper") ? 2 : 1, name.endsWith("helper")));
  seam.digest.mockResolvedValue(createHash("sha256").update(bytes).digest("hex"));
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../../src/platform/process/native-helper-integrity.js");
  vi.resetModules();
});

describe("Linux native helper descriptor binding", () => {
  it("holds every nofollow parent, accepts host write bits and closes the whole chain", async () => {
    const pinned = await nativeHelperLauncher.pinVerifiedLinuxNativeHelper("/host/helper", "hermesProfilePath");
    expect(seam.open.mock.calls.map((call) => call[0])).toEqual(["/", "/proc/self/fd/10/host", "/proc/self/fd/11/helper"]);
    expect(seam.open.mock.calls.every((call) => (call[1] & 131072) !== 0)).toBe(true);
    expect(seam.open.mock.calls.slice(0, 2).every((call) => (call[1] & 65536) !== 0)).toBe(true);
    expect(pinned.fd).toBe(12);
    expect(handles.every((entry) => entry.close.mock.calls.length === 0)).toBe(true);
    await pinned.close();
    await pinned.close();
    expect(handles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });
  it("fails before a symlink parent and releases previously held descriptors", async () => {
    seam.open.mockImplementationOnce(async () => handles[0]).mockRejectedValueOnce(new Error("ELOOP"));
    await expect(nativeHelperLauncher.pinVerifiedLinuxNativeHelper("/host/helper", "hermesProfilePath")).rejects.toThrow("NATIVE_HELPER_PATH_UNSAFE");
    expect(handles[0]?.close).toHaveBeenCalledOnce();
    expect(seam.open).toHaveBeenCalledTimes(2);
  });
  it("preserves the publication lock single-link constraint without applying it to generic helpers", async () => {
    handles[2]?.stat.mockResolvedValue({ ...stats(2, true), nlink: 2n });
    await expect(nativeHelperLauncher.pinVerifiedLinuxNativeHelper("/host/helper", "hermesProfilePath", true)).rejects.toThrow("NATIVE_HELPER_PATH_UNSAFE");
    expect(handles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });
  it.each(["/host/../helper", "/host//helper", "/host/helper\0", "relative/helper"])("rejects noncanonical path %j before opening", async (name) => {
    await expect(nativeHelperLauncher.pinVerifiedLinuxNativeHelper(name, "hermesProfilePath")).rejects.toThrow("NATIVE_HELPER_PATH_UNSAFE");
    expect(seam.open).not.toHaveBeenCalled();
  });
  it.each(["digest", "parent-race", "file-race", "oversize"])("rejects %s without executing and closes all handles", async (fault) => {
    if (fault === "digest") seam.digest.mockResolvedValue("0".repeat(64));
    if (fault === "parent-race") seam.lstat.mockImplementation(async () => stats(99));
    if (fault === "file-race") handles[2]?.stat.mockResolvedValueOnce(stats(2, true)).mockResolvedValue({ ...stats(2, true), mtimeNs: 2n });
    if (fault === "oversize") handles[2]?.stat.mockResolvedValue({ ...stats(2, true), size: 16n * 1024n * 1024n + 1n });
    await expect(nativeHelperLauncher.pinVerifiedLinuxNativeHelper("/host/helper", "hermesProfilePath")).rejects.toThrow(/NATIVE_HELPER_/u);
    expect(seam.spawn).not.toHaveBeenCalled();
    expect(handles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });
  it("executes the inherited verified fd with the caller's bounded stdin", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString(); });
    seam.spawn.mockImplementation(() => { setTimeout(() => child.emit("close", 0), 1); return child; });
    await nativeHelperLauncher.runVerifiedNativeHelper("/host/helper", "hermesProfilePath", ["init-profile"], { input: "public-config", env: {}, timeout: 1000 });
    expect(seam.spawn).toHaveBeenCalledWith("/proc/self/fd/3", ["init-profile"], expect.objectContaining({ shell: false, env: {}, stdio: ["pipe", "pipe", "pipe", 12] }));
    expect(input).toBe("public-config");
    expect(handles.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });
});
