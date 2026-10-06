import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesSourceSnapshotRequest } from "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
type HermesSourceSnapshotModule = typeof import("../../../src/modules/runtime/hermes/hermes-source-snapshot.js");

const disk = vi.hoisted(() => ({ exhausted: false, failPublication: false, occupyPublication: false, failMetadataAliasUnlink: false,
  failProjectionAliasUnlink: false,
  interruptGcRoot: undefined as string | undefined,
  barrier: undefined as undefined | (() => Promise<void>) }));
const nativeHelper = vi.hoisted(() => ({ calls: 0 }));
const snapshotModulePath = "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
const fixtureQueues = new Map<string, Promise<void>>();
const fixtureReferenceCounts = new Map<string, number>();
const fixtureReferenceLock = async ({ cacheRoot }: { cacheRoot: string; mode: "shared" | "exclusive" }) => {
  fixtureReferenceCounts.set(cacheRoot, (fixtureReferenceCounts.get(cacheRoot) ?? 0) + 1);
  let held = true;
  return {
    assertHeld() { if (!held) throw new Error("fixture reference lease lost"); },
    async release() {
      if (!held) return;
      held = false;
      fixtureReferenceCounts.set(cacheRoot, (fixtureReferenceCounts.get(cacheRoot) ?? 1) - 1);
    },
  };
};
const fixturePublicationLock = async ({ cacheRoot }: { cacheRoot: string }) => {
  const previous = fixtureQueues.get(cacheRoot) ?? Promise.resolve();
  let unlock: (() => void) | undefined;
  const next = new Promise<void>((resolveUnlock) => { unlock = resolveUnlock; });
  fixtureQueues.set(cacheRoot, next);
  await previous;
  let held = true;
  return {
    assertHeld() { if (!held) throw new Error("fixture lease lost"); },
    async release() { if (held) { held = false; unlock?.(); } },
  };
};
const lookupHermesSourceSnapshot = (input: { cacheRoot: string; cacheKey: string }) =>
  snapshotModule.lookupHermesSourceSnapshot({ ...input, publicationLock: fixturePublicationLock });
let roots: string[] = [];
let snapshotModule: HermesSourceSnapshotModule;

beforeEach(async () => {
  vi.doUnmock(snapshotModulePath);
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      unlink: async (...args: Parameters<typeof actual.unlink>) => {
        if (disk.failProjectionAliasUnlink && /\.projection-[0-9a-f]{64}-[0-9a-f-]{36}$/u.test(String(args[0]))) {
          disk.failProjectionAliasUnlink = false;
          throw Object.assign(new Error("fixture projection unlink failure"), { code: "EIO" });
        }
        if (disk.failMetadataAliasUnlink && /\.metadata-[0-9a-f]{64}-[0-9a-f-]{36}$/u.test(String(args[0]))) {
          disk.failMetadataAliasUnlink = false;
          throw Object.assign(new Error("fixture metadata unlink failure"), { code: "EIO" });
        }
        if (disk.interruptGcRoot && String(args[0]).startsWith(disk.interruptGcRoot + "/")) {
          disk.interruptGcRoot = undefined;
          await actual.unlink(...args);
          throw Object.assign(new Error("simulated interruption during snapshot GC"), { code: "EIO" });
        }
        return actual.unlink(...args);
      },
      rename: async (...args: Parameters<typeof actual.rename>) => {
        if (disk.failPublication && String(args[0]).includes(".staging-")) throw Object.assign(new Error("fixture IO failure"), { code: "EIO" });
        return actual.rename(...args);
      },
      chmod: async (...args: Parameters<typeof actual.chmod>) => {
        await actual.chmod(...args);
        const stage = String(args[0]);
        if (disk.occupyPublication && /\.staging-[0-9a-f]{64}-[0-9a-f-]{36}$/u.test(stage)) {
          disk.occupyPublication = false;
          const { basename, dirname, join } = await import("node:path");
          await actual.mkdir(join(dirname(stage), basename(stage).slice(9, 73)));
        }
      },
      statfs: async (...args: Parameters<typeof actual.statfs>) => {
        const result = await actual.statfs(...args);
        await disk.barrier?.();
        return disk.exhausted ? { ...result, bavail: 0 } : result;
      },
    };
  });
  nativeHelper.calls = 0;
  vi.doMock("../../../src/platform/process/native-helper-launcher.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/platform/process/native-helper-launcher.js")>();
    return {
      ...actual,
      runVerifiedNativeHelper: async (...args: Parameters<typeof actual.runVerifiedNativeHelper>) => {
        nativeHelper.calls += 1;
        return actual.runVerifiedNativeHelper(...args);
      },
    };
  });
  try {
    snapshotModule = await import("../../../src/modules/runtime/hermes/hermes-source-snapshot.js");
  } catch (error) {
    vi.doUnmock(snapshotModulePath);
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("../../../src/platform/process/native-helper-launcher.js");
    vi.resetModules();
    throw error;
  }
});

afterEach(async () => {
  disk.exhausted = false;
  disk.failPublication = false;
  disk.occupyPublication = false;
  disk.failMetadataAliasUnlink = false;
  disk.failProjectionAliasUnlink = false;
  disk.interruptGcRoot = undefined;
  disk.barrier = undefined;
  try {
    await Promise.all(roots.map(removeFixture));
  } finally {
    roots = [];
    fixtureQueues.clear();
    fixtureReferenceCounts.clear();
    vi.doUnmock(snapshotModulePath);
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("../../../src/platform/process/native-helper-launcher.js");
    vi.resetModules();
  }
});

describe("Hermes shared source snapshot", () => {
  it("derives a stable canonical JCS key and sorted manifest digest from the pinned tree", async () => {
    const fixture = await createFixture({
      "z-last.txt": { content: "last\n" },
      "a-first.txt": { content: "first\n" },
      "bin/hermes-helper": { content: "#!/bin/sh\nexit 0\n", executable: true },
    });
    const request = requestFor(fixture, join(fixture.root, "cache-a"));

    const first = await snapshotModule.materializeHermesSourceSnapshot(request);
    const secondCache = await snapshotModule.materializeHermesSourceSnapshot({ ...request, cacheRoot: join(fixture.root, "cache-b") });
    const manifest = canonicalJson({
      files: [
        { mode: "100644", path: "a-first.txt", sha256: sha256("first\n") },
        { mode: "100755", path: "bin/hermes-helper", sha256: sha256("#!/bin/sh\nexit 0\n") },
        { mode: "100644", path: "z-last.txt", sha256: sha256("last\n") },
      ],
      formatVersion: 1,
    });
    const manifestDigest = sha256(manifest);
    const cacheKey = canonicalJson({
      formatVersion: 1,
      hermesVersion: "Hermes Agent test-pin",
      manifestDigest,
      sourceCommit: fixture.commit,
      sourceTree: fixture.tree,
    });

    expect(first.cacheKey).toBe(cacheKey);
    expect(first.manifestDigest).toBe(manifestDigest);
    expect(first.directoryId).toBe(sha256(cacheKey));
    expect(secondCache.cacheKey).toBe(first.cacheKey);
    expect(secondCache.directoryId).toBe(first.directoryId);
  });

  it("materializes only exact tracked regular files and validates the published tree on lookup", async () => {
    const fixture = await createFixture({
      "hermes/__init__.py": { content: "VALUE = 42\n" },
      "hermes/data/defaults.json": { content: "{\"enabled\":true}\n" },
    });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);

    expect(await readFile(join(created.rootPath, "hermes/__init__.py"), "utf8")).toBe("VALUE = 42\n");
    expect(await readFile(join(created.rootPath, "hermes/data/defaults.json"), "utf8")).toBe("{\"enabled\":true}\n");
    expect((await readdir(created.rootPath)).sort()).toEqual(["hermes"]);
    expect((await lstat(created.rootPath)).isDirectory()).toBe(true);
    expect((await readdir(join(fixture.sourceRoot, ".git"))).length).toBeGreaterThan(0);

    const afterRestart = await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: created.cacheKey });
    expect(afterRestart).toEqual(created);
  });

  it("publishes one restart-stable native projection from the canonical manifest under the source lease", async () => {
    const fixture = await createFixture({
      "z-last.txt": { content: "last\n" },
      "a-first.txt": { content: "first\n" },
      "bin/hermes-helper": { content: "#!/bin/sh\nexit 0\n", executable: true },
    });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);

    const projection = await snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    });
    expect(projection.snapshot).toEqual(created);
    expect(snapshotModule.isVerifiedHermesSourceSnapshot(projection.snapshot)).toBe(true);
    expect(snapshotModule.isVerifiedHermesSourceSnapshot({ ...projection.snapshot })).toBe(false);
    expect(projection.projection.path).toBe(join(request.cacheRoot, `${created.directoryId}.native-v1.bin`));
    const bytes = await readFile(projection.projection.path);
    expect(projection.projection.size).toBe(bytes.byteLength);
    expect(projection.projection.sha256).toBe(sha256(bytes));
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("EHSP");
    expect(bytes.readUInt16LE(4)).toBe(1);
    expect(bytes.readUInt16LE(6)).toBe(0);
    const keyLength = bytes.readUInt32LE(8);
    expect(bytes.subarray(76, 76 + keyLength).toString("utf8")).toBe(created.cacheKey);
    expect(bytes.subarray(12, 44).toString("hex")).toBe(created.directoryId);
    expect(bytes.subarray(44, 76).toString("hex")).toBe(created.manifestDigest);
    let offset = 76 + keyLength;
    const fileCount = bytes.readUInt32LE(offset);
    offset += 4;
    expect(fileCount).toBe(3);
    const decodedEntries: Array<{ path: string; mode: number; sha256: string }> = [];
    for (let index = 0; index < fileCount; index += 1) {
      const pathLength = bytes.readUInt16LE(offset);
      const mode = bytes.readUInt8(offset + 2);
      offset += 3;
      const pathName = bytes.subarray(offset, offset + pathLength).toString("utf8");
      offset += pathLength;
      const digest = bytes.subarray(offset, offset + 32).toString("hex");
      offset += 32;
      decodedEntries.push({ path: pathName, mode, sha256: digest });
    }
    expect(offset).toBe(bytes.byteLength);
    expect(decodedEntries).toEqual([
      { path: "a-first.txt", mode: 0, sha256: sha256("first\n") },
      { path: "bin/hermes-helper", mode: 1, sha256: sha256("#!/bin/sh\nexit 0\n") },
      { path: "z-last.txt", mode: 0, sha256: sha256("last\n") },
    ]);

    const reopened = await snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    });
    expect(reopened).toEqual(projection);
    expect((await readdir(request.cacheRoot)).filter((name) => name.endsWith(".native-v1.bin"))).toEqual([
      `${created.directoryId}.native-v1.bin`,
    ]);
  });

  it("repairs a missing projection under lease but rejects an altered existing projection", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "answer = 42\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);
    const projectionPath = join(request.cacheRoot, `${created.directoryId}.native-v1.bin`);
    await unlink(projectionPath);
    const repaired = await snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    });
    expect(repaired.snapshot).toEqual(created);
    await chmod(projectionPath, 0o600);
    await writeFile(projectionPath, "corrupt projection");
    await expect(snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("fails publication on alias cleanup EIO and recovers the exact owned projection after restart", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "answer = 42\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);
    const projectionPath = join(request.cacheRoot, `${created.directoryId}.native-v1.bin`);
    await unlink(projectionPath);
    disk.failProjectionAliasUnlink = true;
    await expect(snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });

    const reopened = await snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    });
    expect(reopened.snapshot).toEqual(created);
    expect((await lstat(projectionPath)).nlink).toBe(1);
    expect((await readdir(request.cacheRoot)).some((name) => name.startsWith(`.projection-${created.directoryId}-`))).toBe(false);
  });

  it("recovers only a projection alias whose owner record proves the exact file identity", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "answer = 42\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);
    const projectionPath = join(request.cacheRoot, `${created.directoryId}.native-v1.bin`);
    const nonce = "12345678-1234-1234-1234-123456789abc";
    const aliasPath = join(request.cacheRoot, `.projection-${created.directoryId}-${nonce}`);
    await link(projectionPath, aliasPath);
    const identity = await lstat(projectionPath);
    await writeFile(aliasPath + ".owner", JSON.stringify({
      directoryId: created.directoryId, nonce,
      fileIdentity: { dev: identity.dev, ino: identity.ino }, formatVersion: 1, pid: 2147483647,
    }));

    const recovered = await snapshotModule.ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: request.cacheRoot, cacheKey: created.cacheKey, publicationLock: fixturePublicationLock,
    });
    expect(recovered.snapshot).toEqual(created);
    expect(await lstat(projectionPath).then((stats) => stats.nlink)).toBe(1);
    await expect(lstat(aliasPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects additions, removals, replacements, and modified bytes in an existing cache entry", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "answer = 42\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);

    await chmod(join(created.rootPath, "pkg/module.py"), 0o600);
    await writeFile(join(created.rootPath, "pkg/module.py"), "answer = 7\n");
    await expect(lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: created.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    await expect(snapshotModule.materializeHermesSourceSnapshot(request))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("rejects a corrupt local Git blob before publishing any cache entry", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "answer = 42\n" } });
    const blob = git(fixture.sourceRoot, ["rev-parse", `${fixture.commit}:pkg/module.py`]).trim();
    const objectPath = join(fixture.sourceRoot, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, "corrupt loose object");
    const cacheRoot = join(fixture.root, "cache");

    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot)))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readdir(cacheRoot)).toEqual([]);
  });

  it("rejects unsafe and case-colliding paths in the pinned tree", async () => {
    const unsafe = await createRawTreeFixture([{ name: "..", mode: "40000", children: [{ name: "escape.py", mode: "100644", content: "x" }] }]);
    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor(unsafe, join(unsafe.root, "cache"))))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });

    const colliding = await createRawTreeFixture([
      { name: "Module.py", mode: "100644", content: "upper" },
      { name: "module.py", mode: "100644", content: "lower" },
    ]);
    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor(colliding, join(colliding.root, "cache"))))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("rejects symlinks and non-regular Git tree entries", async () => {
    const fixture = await createFixture({ "pkg/target.py": { content: "safe\n" } });
    const targetBlob = git(fixture.sourceRoot, ["hash-object", "-w", "--stdin"], Buffer.from("target.py")).trim();
    git(fixture.sourceRoot, ["update-index", "--add", "--cacheinfo", `120000,${targetBlob},pkg/link`]);
    git(fixture.sourceRoot, ["commit", "-m", "symlink tree"]);
    const symlinkCommit = git(fixture.sourceRoot, ["rev-parse", "HEAD"]).trim();
    const symlinkTree = git(fixture.sourceRoot, ["rev-parse", "HEAD^{tree}"]).trim();

    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor({ ...fixture, commit: symlinkCommit, tree: symlinkTree }, join(fixture.root, "cache"))))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("serializes concurrent first publishers and exposes only one complete deterministic entry", async () => {
    const fixture = await createFixture({
      "one.py": { content: "one\n" },
      "two.py": { content: "two\n" },
      "nested/three.py": { content: "three\n" },
    });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const [left, right, lookup] = await Promise.all([
      snapshotModule.materializeHermesSourceSnapshot(request),
      snapshotModule.materializeHermesSourceSnapshot(request),
      snapshotModule.materializeHermesSourceSnapshot(request),
    ]);

    expect(left).toEqual(right);
    expect(left).toEqual(lookup);
    expect(await readFile(join(left.rootPath, "nested/three.py"), "utf8")).toBe("three\n");
    const inventory = await readdir(request.cacheRoot);
    expect(inventory.filter((entry) => /^[a-f0-9]{64}$/u.test(entry))).toEqual([left.directoryId]);
    expect(inventory.filter((entry) => entry.endsWith(".native-v1.bin"))).toEqual([`${left.directoryId}.native-v1.bin`]);
    expect(inventory.some((entry) => entry.includes("staging") || entry.startsWith(".projection-"))).toBe(false);
  });

  it("rejects valid compressed Git objects whose bytes no longer match their object ID", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const blob = git(fixture.sourceRoot, ["rev-parse", `${fixture.commit}:module.py`]).trim();
    const objectPath = join(fixture.sourceRoot, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, deflateSync(Buffer.from("blob 9\0modified\n")));
    const cacheRoot = join(fixture.root, "cache");
    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot)))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readdir(cacheRoot)).toEqual([]);
  });

  it.each(["tree", "commit"])("rejects corrupted %s objects even when Git still parses them", async (kind) => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const oid = kind === "tree" ? fixture.tree : fixture.commit;
    const raw = execFileSync("git", ["-C", fixture.sourceRoot, "cat-file", kind, oid]);
    const altered = kind === "tree" ? Buffer.from(raw) : Buffer.from(raw.toString("utf8").replace("fixture source", "changed source"));
    if (kind === "tree") altered[altered.indexOf(Buffer.from("module.py"))] = "n".charCodeAt(0);
    const objectPath = join(fixture.sourceRoot, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, deflateSync(Buffer.concat([Buffer.from(`${kind} ${altered.length}\0`), altered])));
    await expect(snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, join(fixture.root, "cache"))))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("fails closed for a second source identity and keeps the original published snapshot", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    await expect(snapshotModule.materializeHermesSourceSnapshot({ ...request, hermesVersion: "different pin" }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: original.cacheKey })).toEqual(original);
    expect((await readdir(request.cacheRoot)).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([original.directoryId]);
  });

  it("serializes different source identities under the one-copy limit", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const results = await Promise.allSettled([
      snapshotModule.materializeHermesSourceSnapshot(request),
      snapshotModule.materializeHermesSourceSnapshot({ ...request, hermesVersion: "different pin" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readdir(request.cacheRoot)).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toHaveLength(1);
  });

  it("rejects insufficient reserve before staging and preserves existing entries", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    disk.exhausted = true;
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readdir(request.cacheRoot)).toEqual([]);
    disk.exhausted = false;
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    disk.exhausted = true;
    expect(await snapshotModule.materializeHermesSourceSnapshot(request)).toEqual(original);
  });

  it("recovers only abandoned staging owned by the exact key and preserves unrelated directories", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    await removeFixture(original.rootPath);
    const nonce = "12345678-1234-1234-1234-123456789012";
    const abandoned = join(request.cacheRoot, `.staging-${original.directoryId}-${nonce}`);
    await mkdir(abandoned);
    await writeFile(abandoned + ".owner", canonicalJson({ directoryId: original.directoryId, nonce, pid: 2147483647, startedAt: 1 }));
    await writeFile(join(abandoned, "partial.py"), "partial");
    const unrelated = join(request.cacheRoot, ".staging-unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "kept");
    expect(await snapshotModule.materializeHermesSourceSnapshot(request)).toEqual(original);
    await expect(lstat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("kept");
  });

  it("removes sealed owned staging after publication failure and retries with the original metadata", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    disk.failPublication = true;
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect((await readdir(request.cacheRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
    expect((await readdir(request.cacheRoot)).filter((entry) => /^[0-9a-f]{64}$/u.test(entry))).toEqual([]);
    disk.failPublication = false;
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    expect(await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: original.cacheKey })).toEqual(original);
  });

  it("does not replace an entry which appears before publication", async () => {
    const fixture = await createFixture({ "pkg/module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    disk.occupyPublication = true;
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    const published = (await readdir(request.cacheRoot)).find((entry) => /^[0-9a-f]{64}$/u.test(entry));
    expect(published).toBeDefined();
    expect(await readdir(join(request.cacheRoot, published!))).toEqual([]);
    expect((await readdir(request.cacheRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
  });

  it("retains unverifiable staging and refuses to create a second source copy", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    await mkdir(request.cacheRoot, { mode: 0o700 });
    const nonce = "12345678-1234-1234-1234-123456789012";
    const staging = join(request.cacheRoot, `.staging-${"f".repeat(64)}-${nonce}`);
    await mkdir(staging);
    await writeFile(join(staging, "partial"), "retained");
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readFile(join(staging, "partial"), "utf8")).toBe("retained");
    expect(await readdir(request.cacheRoot)).toEqual([`.staging-${"f".repeat(64)}-${nonce}`]);
  });

  it("does not publish two copies after the native helper dies while its Node publisher is paused", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    let reserved = false;
    let helperAlive = true;
    const nativeReservationFixture = async () => {
      if (reserved) throw new Error("live Node owner reservation retained");
      reserved = true;
      return {
        assertHeld() { if (!helperAlive) throw new Error("native helper died"); },
        async release() { if (!helperAlive) throw new Error("reservation retained until Node restart"); reserved = false; },
      };
    };
    let markPaused: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const paused = new Promise<void>((resolvePaused) => { markPaused = resolvePaused; });
    const resumed = new Promise<void>((resolveResumed) => { resume = resolveResumed; });
    let checks = 0;
    disk.barrier = async () => { if (++checks === 2) { markPaused?.(); await resumed; } };
    const first = snapshotModule.materializeHermesSourceSnapshot({ ...request, publicationLock: nativeReservationFixture });
    const firstSettled = first.then(() => undefined, () => undefined);
    try {
      await paused;
      helperAlive = false;
      await expect(snapshotModule.materializeHermesSourceSnapshot({ ...request, hermesVersion: "different pin", publicationLock: nativeReservationFixture }))
        .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
      resume?.();
      await expect(first).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
      expect(await readdir(request.cacheRoot)).toEqual([]);
      expect(reserved).toBe(true);
    } finally {
      resume?.();
      await firstSettled;
    }
  });

  it("fails closed on metadata alias unlink error and recovers its exact alias on retry", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    disk.failMetadataAliasUnlink = true;
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    const names = await readdir(request.cacheRoot);
    const metadataName = names.find((name) => name.endsWith(".manifest.json"));
    expect(metadataName).toBeDefined();
    if (!metadataName) throw new Error("fixture metadata missing");
    expect((await lstat(join(request.cacheRoot, metadataName))).nlink).toBe(2);
    expect(names.filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([]);
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);
    expect(await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: created.cacheKey })).toEqual(created);
    expect((await lstat(join(request.cacheRoot, metadataName))).nlink).toBe(1);
    expect((await readdir(request.cacheRoot)).filter((name) => name.startsWith(".metadata-"))).toEqual([]);
  });

  it("recovers an owned metadata alias after restart and refuses aliases without ownership evidence", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const created = await snapshotModule.materializeHermesSourceSnapshot(request);
    const metadataPath = join(request.cacheRoot, created.directoryId + ".manifest.json");
    const nonce = "12345678-1234-1234-1234-123456789012";
    const alias = join(request.cacheRoot, `.metadata-${created.directoryId}-${nonce}`);
    const { link } = await import("node:fs/promises");
    await link(metadataPath, alias);
    const identity = await lstat(metadataPath);
    await writeFile(alias + ".owner", canonicalJson({ directoryId: created.directoryId, nonce, fileIdentity: { dev: identity.dev, ino: identity.ino }, formatVersion: 1 }));
    expect(await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: created.cacheKey })).toEqual(created);
    await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
    await link(metadataPath, alias);
    await expect(lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: created.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect((await lstat(alias)).nlink).toBe(2);
  });

  it("looks up the exact persisted identity without the current installation", async () => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    await removeFixture(fixture.sourceRoot);
    expect(await lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: original.cacheKey })).toEqual(original);
    await expect(lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: " " + original.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("collects the prior snapshot only after the durable owner policy accepts it", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    await expect(snapshotModule.materializeHermesSourceSnapshot(nextRequest))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await lstat(first.rootPath)).toBeDefined();

    const next = await snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    });
    expect(next.cacheKey).not.toBe(first.cacheKey);
    expect(await readdir(cacheRoot)).toContain(next.directoryId);
    expect(await readdir(cacheRoot)).not.toContain(first.directoryId);
    await expect(lookupHermesSourceSnapshot({ cacheRoot, cacheKey: next.cacheKey })).resolves.toEqual(next);
  });

  it("resumes identity-bound collection after interruption partway through deleting the snapshot", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    await unlink(join(first.rootPath, "module.py"));

    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    const next = await snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    });
    expect(next.cacheKey).not.toBe(first.cacheKey);
    await expect(lstat(first.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lookupHermesSourceSnapshot({ cacheRoot, cacheKey: next.cacheKey })).resolves.toEqual(next);
  });

  it.each([
    ["contents deleted, root and sidecars remain", false, false, false],
    ["root deleted, metadata and projection remain", true, false, false],
    ["root and metadata deleted, projection remains", true, true, false],
    ["root and both sidecars deleted, intent remains", true, true, true],
  ])("recovers durable cleanup state after %s", async (_label, rootAbsent, metadataAbsent, projectionAbsent) => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    if (rootAbsent) await rm(first.rootPath, { recursive: true });
    else { await chmod(join(first.rootPath, "module.py"), 0o600); await unlink(join(first.rootPath, "module.py")); }
    const metadataPath = join(cacheRoot, `${first.directoryId}.manifest.json`);
    const projectionPath = join(cacheRoot, `${first.directoryId}.native-v1.bin`);
    if (metadataAbsent) { await chmod(metadataPath, 0o600); await unlink(metadataPath); }
    if (projectionAbsent) { await chmod(projectionPath, 0o600); await unlink(projectionPath); }
    expect(await pathExistsForTest(first.rootPath)).toBe(!rootAbsent);
    expect(await pathExistsForTest(metadataPath)).toBe(!metadataAbsent);
    expect(await pathExistsForTest(projectionPath)).toBe(!projectionAbsent);
    expect(await pathExistsForTest(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).toBe(true);

    const next = await snapshotModule.materializeHermesSourceSnapshot({
      ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    });
    expect(next.cacheKey).not.toBe(first.cacheKey);
    await expect(lstat(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(projectionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(first.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an impossible root-present metadata-missing cleanup state without deleting survivors", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    const metadataPath = join(cacheRoot, `${first.directoryId}.manifest.json`);
    const projectionPath = join(cacheRoot, `${first.directoryId}.native-v1.bin`);
    await chmod(metadataPath, 0o600);
    await unlink(metadataPath);

    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    await expect(lstat(first.rootPath)).resolves.toBeDefined();
    await expect(lstat(projectionPath)).resolves.toBeDefined();
    await expect(lstat(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).resolves.toBeDefined();
  });

  it("refuses an impossible root-present projection-missing cleanup state without deleting survivors", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    const metadataPath = join(cacheRoot, `${first.directoryId}.manifest.json`);
    const projectionPath = join(cacheRoot, `${first.directoryId}.native-v1.bin`);
    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(metadataPath, 0o600);
    await chmod(projectionPath, 0o600);
    await unlink(projectionPath);

    await expect(snapshotModule.materializeHermesSourceSnapshot({ ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    await expect(lstat(join(cacheRoot, first.directoryId))).resolves.toBeDefined();
    await expect(lstat(metadataPath)).resolves.toBeDefined();
    await expect(lstat(intentPath)).resolves.toBeDefined();
    await expect(lstat(projectionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses missing projection after root is gone while metadata remains", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    const metadataPath = join(cacheRoot, `${first.directoryId}.manifest.json`);
    const projectionPath = join(cacheRoot, `${first.directoryId}.native-v1.bin`);
    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(join(cacheRoot, first.directoryId), 0o700);
    await rm(join(cacheRoot, first.directoryId), { recursive: true, force: true });
    await chmod(projectionPath, 0o600);
    await unlink(projectionPath);

    await expect(snapshotModule.materializeHermesSourceSnapshot({ ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    await expect(lstat(join(cacheRoot, first.directoryId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(metadataPath)).resolves.toBeDefined();
    await expect(lstat(projectionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(intentPath)).resolves.toBeDefined();
  });

  it("rebuilds the same requested identity after resuming an interrupted GC intent", async () => {
    const fixture = await createFixture({ "module.py": { content: "same snapshot\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const first = await snapshotModule.materializeHermesSourceSnapshot(request);
    await writeFixtureGcIntent(request.cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    await unlink(join(first.rootPath, "module.py"));

    const recovered = await snapshotModule.materializeHermesSourceSnapshot({
      ...request,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    });
    expect(recovered.cacheKey).toBe(first.cacheKey);
    expect(await readFile(join(recovered.rootPath, "module.py"), "utf8")).toBe("same snapshot\n");
    await expect(lstat(join(request.cacheRoot, `.gc-${first.directoryId}.intent.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to resume a cleanup intent after the candidate root identity is replaced", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    await rm(first.rootPath, { recursive: true });
    await mkdir(first.rootPath);

    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readdir(cacheRoot)).toContain(`.gc-${first.directoryId}.intent.json`);
  });

  it("fails closed when a surviving snapshot file was changed after GC interruption", async () => {
    const fixture = await createFixture({ "a.py": { content: "first\n" }, "b.py": { content: "expected\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    await unlink(join(first.rootPath, "a.py"));
    await chmod(join(first.rootPath, "b.py"), 0o600);
    await writeFile(join(first.rootPath, "b.py"), "tampered\n");

    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readFile(join(first.rootPath, "b.py"), "utf8")).toBe("tampered\n");
    await expect(lstat(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).resolves.toBeDefined();
  });

  it("fails closed when an unknown object appears after GC interruption", async () => {
    const fixture = await createFixture({ "a.py": { content: "first\n" }, "b.py": { content: "second\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await chmod(first.rootPath, 0o700);
    await unlink(join(first.rootPath, "a.py"));
    await writeFile(join(first.rootPath, "unexpected.py"), "unowned\n");

    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async (key) => key === first.cacheKey,
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(await readFile(join(first.rootPath, "unexpected.py"), "utf8")).toBe("unowned\n");
    await expect(lstat(join(cacheRoot, `.gc-${first.directoryId}.intent.json`))).resolves.toBeDefined();
  });

  it("rejects a canonical forged GC intent with a platform-invalid path before cleanup", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await removeFixture(first.rootPath);
    for (const sidecar of [`${first.directoryId}.manifest.json`, `${first.directoryId}.native-v1.bin`]) {
      const sidecarPath = join(cacheRoot, sidecar);
      await chmod(sidecarPath, 0o600);
      await unlink(sidecarPath);
    }

    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    const forged = JSON.parse(await readFile(intentPath, "utf8")) as { nodes: Array<{ path: string }> };
    forged.nodes[0]!.path = process.platform === "win32" ? "a".repeat(241) : "界".repeat(86);
    await chmod(intentPath, 0o600);
    await writeFile(intentPath, canonicalJson(forged));
    await chmod(intentPath, 0o400);

    let cleanupCalled = false;
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey,
      removeSnapshotTree: async () => { cleanupCalled = true; },
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(cleanupCalled).toBe(false);
    await expect(lstat(intentPath)).resolves.toBeDefined();
  });

  it("rejects canonical forged GC intents with invalid path forms before native helper invocation", async () => {
    const invalidPaths = ["CON.txt", "bad?.txt", "bad\u0001.txt", "bad.", ".git/config"];
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await removeFixture(first.rootPath);
    for (const sidecar of [`${first.directoryId}.manifest.json`, `${first.directoryId}.native-v1.bin`]) {
      const sidecarPath = join(cacheRoot, sidecar);
      await chmod(sidecarPath, 0o600);
      await unlink(sidecarPath);
    }

    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    const original = JSON.parse(await readFile(intentPath, "utf8")) as { nodes: Array<Record<string, unknown>> };
    const { removeSnapshotTree, ...nativeCleanupRequest } = requestFor(fixture, cacheRoot);
    void removeSnapshotTree;
    for (const invalidPath of invalidPaths) {
      const forged = { ...original, nodes: original.nodes.map((node) => ({ ...node, path: invalidPath })) };
      await chmod(intentPath, 0o600);
      await writeFile(intentPath, canonicalJson(forged));
      await chmod(intentPath, 0o400);
      await expect(snapshotModule.materializeHermesSourceSnapshot({
        ...nativeCleanupRequest, hermesVersion: "Hermes Agent next-pin",
        mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey,
      })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
      expect(nativeHelper.calls).toBe(0);
    }
    await expect(lstat(intentPath)).resolves.toBeDefined();
  });

  it("rejects canonical forged GC intents with duplicate, case-folded, or file-parent collisions", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await removeFixture(first.rootPath);
    for (const sidecar of [`${first.directoryId}.manifest.json`, `${first.directoryId}.native-v1.bin`]) {
      const sidecarPath = join(cacheRoot, sidecar);
      await chmod(sidecarPath, 0o600);
      await unlink(sidecarPath);
    }
    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    const original = JSON.parse(await readFile(intentPath, "utf8")) as { nodes: Array<Record<string, unknown>> };
    const fileNode = original.nodes.find((node) => node.kind === "file")!;
    const childNode = { ...fileNode, path: "parent/child.py" };
    const parentFileNode = { ...fileNode, path: "parent" };
    const cases = [
      [...original.nodes, { ...fileNode, path: fileNode.path }],
      [...original.nodes, { ...fileNode, path: "MODULE.py" }],
      [parentFileNode, childNode],
      [childNode],
    ];
    const { removeSnapshotTree, ...nativeCleanupRequest } = requestFor(fixture, cacheRoot);
    void removeSnapshotTree;
    for (const nodes of cases) {
      const forged = { ...original, nodes };
      await chmod(intentPath, 0o600);
      await writeFile(intentPath, canonicalJson(forged));
      await chmod(intentPath, 0o400);
      await expect(snapshotModule.materializeHermesSourceSnapshot({
        ...nativeCleanupRequest, hermesVersion: "Hermes Agent next-pin",
        mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey,
      })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
      expect(nativeHelper.calls).toBe(0);
    }
    await expect(lstat(intentPath)).resolves.toBeDefined();
  });

  it("rejects a canonical forged intent that exceeds the durable per-kind node cap", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    await writeFixtureGcIntent(cacheRoot, first);
    await removeFixture(first.rootPath);
    for (const sidecar of [`${first.directoryId}.manifest.json`, `${first.directoryId}.native-v1.bin`]) {
      const sidecarPath = join(cacheRoot, sidecar);
      await chmod(sidecarPath, 0o600);
      await unlink(sidecarPath);
    }

    const intentPath = join(cacheRoot, `.gc-${first.directoryId}.intent.json`);
    const forged = JSON.parse(await readFile(intentPath, "utf8")) as { nodes: unknown[] };
    const modeBits = process.platform === "win32" ? 0o444 : 0o400;
    const fileNode = { identity: { dev: "1", ino: "2" }, kind: "file", mode: "100644", modeBits, path: "f", sha256: "0".repeat(64) };
    forged.nodes = Array.from({ length: 100_001 }, (_, index) => ({ ...fileNode, path: `f${index}` }));
    const forgedText = canonicalJson(forged);
    expect(Buffer.byteLength(forgedText, "utf8")).toBeLessThan(64 * 1024 * 1024);
    await chmod(intentPath, 0o600);
    await writeFile(intentPath, forgedText);
    await chmod(intentPath, 0o400);

    let cleanupCalled = false;
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin",
      mayCollectSnapshot: async (cacheKey) => cacheKey === first.cacheKey,
      removeSnapshotTree: async () => { cleanupCalled = true; },
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(cleanupCalled).toBe(false);
    await expect(lstat(intentPath)).resolves.toBeDefined();
  });

  it("allows simultaneous same-key Run preflights to share the pending reference lease", async () => {
    const fixture = await createFixture({ "module.py": { content: "same-source\n" } });
    const request = { ...requestFor(fixture, join(fixture.root, "cache")), retainReferenceLease: true };
    const [first, second] = await Promise.all([
      snapshotModule.materializeHermesSourceSnapshot(request),
      snapshotModule.materializeHermesSourceSnapshot(request),
    ]);
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(fixtureReferenceCounts.get(request.cacheRoot)).toBe(2);
    await Promise.all([
      snapshotModule.releaseHermesSourceSnapshotReferenceLease(first),
      snapshotModule.releaseHermesSourceSnapshotReferenceLease(second),
    ]);
    expect(fixtureReferenceCounts.get(request.cacheRoot)).toBe(0);
  });

  it("refuses candidate replacement by a symlink while the collection policy is evaluated", async () => {
    const fixture = await createFixture({ "module.py": { content: "snapshot\n" } });
    const cacheRoot = join(fixture.root, "cache");
    const first = await snapshotModule.materializeHermesSourceSnapshot(requestFor(fixture, cacheRoot));
    const nextRequest = { ...requestFor(fixture, cacheRoot), hermesVersion: "Hermes Agent next-pin" };
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await expect(snapshotModule.materializeHermesSourceSnapshot({
      ...nextRequest,
      mayCollectSnapshot: async () => {
        await chmod(first.rootPath, 0o700);
        await import("node:fs/promises").then(({ rm }) => rm(first.rootPath, { recursive: true }));
        await import("node:fs/promises").then(({ symlink }) => symlink(outside, first.rootPath, "junction"));
        return true;
      },
    })).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect((await lstat(first.rootPath)).isSymbolicLink()).toBe(true);
  });

  it.each(["extra", "missing", "hardlink", "metadata"])("rejects %s corruption without replacing the entry", async (kind) => {
    const fixture = await createFixture({ "module.py": { content: "original\n" } });
    const request = requestFor(fixture, join(fixture.root, "cache"));
    const original = await snapshotModule.materializeHermesSourceSnapshot(request);
    await chmod(original.rootPath, 0o700);
    const file = join(original.rootPath, "module.py");
    if (kind === "extra") await writeFile(join(original.rootPath, "extra.py"), "unexpected");
    if (kind === "missing") { await chmod(file, 0o600); await unlink(file); }
    if (kind === "hardlink") {
      const { link } = await import("node:fs/promises");
      await link(file, join(request.cacheRoot, "outside-link"));
    }
    if (kind === "metadata") {
      const metadata = join(request.cacheRoot, original.directoryId + ".manifest.json");
      await chmod(metadata, 0o600);
      await writeFile(metadata, "{}");
    }
    await expect(lookupHermesSourceSnapshot({ cacheRoot: request.cacheRoot, cacheKey: original.cacheKey }))
      .rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
    await expect(snapshotModule.materializeHermesSourceSnapshot(request)).rejects.toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
  });
});

async function removeFixture(root: string): Promise<void> {
  const details = await lstat(root).catch(() => undefined);
  if (!details) return;
  if (!details.isSymbolicLink()) {
    await chmod(root, details.isDirectory() ? 0o700 : 0o600);
    if (details.isDirectory()) for (const child of await readdir(root)) await removeFixture(join(root, child));
  }
  await rm(root, { recursive: true, force: true });
}

async function writeFixtureGcIntent(cacheRoot: string, snapshot: {
  readonly cacheKey: string;
  readonly directoryId: string;
  readonly manifestDigest: string;
  readonly rootPath: string;
}): Promise<void> {
  const metadataPath = join(cacheRoot, snapshot.directoryId + ".manifest.json");
  const projectionPath = join(cacheRoot, snapshot.directoryId + ".native-v1.bin");
  const [root, metadata, projection, metadataBytes, projectionBytes] = await Promise.all([
    lstat(snapshot.rootPath, { bigint: true }), lstat(metadataPath, { bigint: true }), lstat(projectionPath, { bigint: true }), readFile(metadataPath), readFile(projectionPath),
  ]);
  const intent = {
    cacheKey: snapshot.cacheKey,
    directoryId: snapshot.directoryId,
    formatVersion: 1,
    manifestDigest: snapshot.manifestDigest,
    metadataIdentity: { dev: String(metadata.dev), ino: String(metadata.ino) },
    metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    nodes: await readFixtureSnapshotNodes(snapshot.rootPath),
    projectionIdentity: { dev: String(projection.dev), ino: String(projection.ino) },
    projectionSha256: createHash("sha256").update(projectionBytes).digest("hex"),
    rootIdentity: { dev: String(root.dev), ino: String(root.ino) },
  };
  await writeFile(join(cacheRoot, `.gc-${snapshot.directoryId}.intent.json`), JSON.stringify(intent), { mode: 0o600 });
}

async function readFixtureSnapshotNodes(root: string): Promise<Array<{
  readonly identity: { readonly dev: string; readonly ino: string };
  readonly kind: "directory" | "file";
  readonly mode: "100644" | "100755" | null;
  readonly modeBits: number;
  readonly path: string;
  readonly sha256: string | null;
}>> {
  const nodes: Array<{
    identity: { dev: string; ino: string };
    kind: "directory" | "file";
    mode: "100644" | "100755" | null;
    modeBits: number;
    path: string;
    sha256: string | null;
  }> = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const childPath = relative ? `${relative}/${entry.name}` : entry.name;
      const child = join(absolute, entry.name);
      const details = await lstat(child, { bigint: true });
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) throw new Error("fixture tree is not regular");
      const file = details.isFile();
      const modeBits = Number(details.mode & 0o777n);
      nodes.push({
        identity: { dev: String(details.dev), ino: String(details.ino) },
        kind: file ? "file" : "directory",
        mode: file ? ([0o500, 0o555].includes(modeBits) ? "100755" : "100644") : null,
        modeBits,
        path: childPath,
        sha256: file ? createHash("sha256").update(await readFile(child)).digest("hex") : null,
      });
      if (!file) await visit(child, childPath);
    }
  };
  await visit(root, "");
  return nodes.sort((left, right) => left.path.localeCompare(right.path));
}

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly commit: string;
  readonly tree: string;
}

async function createFixture(files: Record<string, { content: string; executable?: boolean }>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ebb-hermes-source-snapshot-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  git(sourceRoot, ["init", "-q"]);
  git(sourceRoot, ["config", "user.name", "Snapshot Test"]);
  git(sourceRoot, ["config", "user.email", "snapshot@example.invalid"]);
  for (const [relativePath, file] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, ...relativePath.split("/"));
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, file.content);
  }
  git(sourceRoot, ["add", "--all"]);
  for (const [relativePath, file] of Object.entries(files)) {
    if (file.executable) git(sourceRoot, ["update-index", "--chmod=+x", "--", relativePath]);
  }
  git(sourceRoot, ["commit", "-q", "-m", "fixture source"]);
  return {
    root,
    sourceRoot,
    commit: git(sourceRoot, ["rev-parse", "HEAD"]).trim(),
    tree: git(sourceRoot, ["rev-parse", "HEAD^{tree}"]).trim(),
  };
}

async function createRawTreeFixture(entries: RawTreeEntry[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ebb-hermes-source-snapshot-raw-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot, { recursive: true });
  git(sourceRoot, ["init", "-q"]);
  git(sourceRoot, ["config", "user.name", "Snapshot Test"]);
  git(sourceRoot, ["config", "user.email", "snapshot@example.invalid"]);
  const tree = await writeRawTree(sourceRoot, entries);
  const commitBytes = Buffer.from(`tree ${tree}\nauthor Snapshot Test <snapshot@example.invalid> 1 +0000\ncommitter Snapshot Test <snapshot@example.invalid> 1 +0000\n\nfixture\n`);
  const commit = git(sourceRoot, ["hash-object", "-t", "commit", "-w", "--stdin"], commitBytes).trim();
  git(sourceRoot, ["update-ref", "refs/heads/main", commit]);
  return { root, sourceRoot, commit, tree };
}

interface RawTreeEntry {
  readonly name: string;
  readonly mode: "100644" | "100755" | "40000";
  readonly content?: string;
  readonly children?: readonly RawTreeEntry[];
}

async function writeRawTree(sourceRoot: string, entries: readonly RawTreeEntry[]): Promise<string> {
  const records: Buffer[] = [];
  for (const entry of entries) {
    const mode = entry.mode;
    const oid = mode === "40000"
      ? await writeRawTree(sourceRoot, entry.children ?? [])
      : git(sourceRoot, ["hash-object", "-w", "--stdin"], Buffer.from(entry.content ?? "")).trim();
    records.push(Buffer.from(`${mode} ${entry.name}\0`, "utf8"), Buffer.from(oid, "hex"));
  }
  const bytes = Buffer.concat(records);
  return git(sourceRoot, ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"], bytes).trim();
}

function requestFor(fixture: Fixture, cacheRoot: string): HermesSourceSnapshotRequest {
  return {
    publicationLock: fixturePublicationLock,
    referenceLock: fixtureReferenceLock,
    gitExecutable: "git",
    sourceRoot: fixture.sourceRoot,
    cacheRoot,
    hermesVersion: "Hermes Agent test-pin",
    commit: fixture.commit,
    tree: fixture.tree,
    removeSnapshotTree: async (root, value) => {
      const intent = value as { directoryId: string; projectionIdentity: unknown };
      await rm(join(root, intent.directoryId), { recursive: true, force: true });
      for (const path of [join(root, `${intent.directoryId}.native-v1.bin`), join(root, `${intent.directoryId}.manifest.json`),
        join(root, `.gc-${intent.directoryId}.intent.json`)]) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
    },
  };
}

async function pathExistsForTest(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
