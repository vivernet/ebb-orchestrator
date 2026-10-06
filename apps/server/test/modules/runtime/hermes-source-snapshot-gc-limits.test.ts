import { describe, expect, it } from "vitest";
import {
  assertHermesSourceRelativePathFits,
  assertHermesSourceSnapshotGcIntentFits,
  assertHermesSourceSnapshotGcTreeFits,
  HERMES_SOURCE_SNAPSHOT_GC_LIMITS,
  isHermesSourceSnapshotGcNodeInventoryWithinLimits,
  isHermesSourceSnapshotRelativePathValid,
} from "../../../src/modules/runtime/hermes/hermes-source-snapshot-gc-limits.js";

describe("Hermes source snapshot GC resource bounds", () => {
  it("accepts the maximum supported source node count", () => {
    const paths = Array.from({ length: 100_000 }, (_, index) => `d${index.toString().padStart(6, "0")}/f`);
    expect(() => assertHermesSourceSnapshotGcTreeFits(paths)).not.toThrow();
  });

  it("allows exactly 200,000 inventory nodes in a durable intent", () => {
    expect(() => assertHermesSourceSnapshotGcIntentFits(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.intentBytes, 200_000)).not.toThrow();
    expect(() => assertHermesSourceSnapshotGcIntentFits(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.intentBytes, 200_001)).toThrow(/node budget/u);
  });

  it("rejects a directory inventory beyond its cap while preserving the file cap", () => {
    const paths = Array.from({ length: 100_000 }, (_, index) => `d${index.toString().padStart(6, "0")}/s/f`);
    expect(() => assertHermesSourceSnapshotGcTreeFits(paths)).toThrow(/directory budget/u);
  });

  it("accepts a path at the UTF-8 byte boundary and rejects one beyond it", () => {
    const exact = "界".repeat(Math.floor(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.pathBytes / 3));
    expect(Buffer.byteLength(exact, "utf8")).toBeLessThanOrEqual(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.pathBytes);
    expect(() => assertHermesSourceSnapshotGcTreeFits([exact])).not.toThrow();
    expect(() => assertHermesSourceSnapshotGcTreeFits([`${exact}界`])).toThrow(/path exceeds/u);
  });

  it("uses Windows UTF-16 units and POSIX NAME_MAX UTF-8 bytes consistently", () => {
    const chineseComponent = "界".repeat(100);
    expect(() => assertHermesSourceRelativePathFits(chineseComponent, "win32")).not.toThrow();
    expect(() => assertHermesSourceRelativePathFits(chineseComponent, "linux")).toThrow(/NAME_MAX/u);
    expect(() => assertHermesSourceRelativePathFits("a/界".repeat(20), "linux")).not.toThrow();
    expect(() => assertHermesSourceRelativePathFits("😀".repeat(120), "win32")).not.toThrow();
    expect(() => assertHermesSourceRelativePathFits("😀".repeat(121), "win32")).toThrow(/UTF-16 path limit/u);
    const composedCodePoint = "é".normalize("NFC");
    expect(() => assertHermesSourceRelativePathFits(composedCodePoint.repeat(240), "win32")).not.toThrow();
    expect(() => assertHermesSourceRelativePathFits(composedCodePoint.repeat(241), "win32")).toThrow(/UTF-16 path limit/u);
  });

  it("applies file and directory caps to recovered inventories", () => {
    const files = Array.from({ length: 100_000 }, (_, index) => ({ kind: "file", path: `f${index}` }));
    const directories = Array.from({ length: 100_000 }, (_, index) => ({ kind: "directory", path: `d${index}` }));
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits(files)).toBe(true);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([...files, { kind: "file", path: "overflow" }])).toBe(false);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits(directories)).toBe(true);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([...directories, { kind: "directory", path: "overflow" }])).toBe(false);
  });

  it("applies the complete producer path rules to recovered node paths", () => {
    for (const path of ["CON.txt", "aux", "LPT9.log", "bad?.txt", "bad\u0001.txt", "bad.", "bad ", ".git/config", "a/../b"]) {
      expect(isHermesSourceSnapshotRelativePathValid(path)).toBe(false);
      expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([{ kind: "file", path }])).toBe(false);
    }
    expect(isHermesSourceSnapshotRelativePathValid("pkg/module.py")).toBe(true);
  });

  it("rejects recovered inventories with duplicate, folded, or structurally invalid paths", () => {
    const file = (path: string) => ({ kind: "file", path });
    const directory = (path: string) => ({ kind: "directory", path });
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([file("module.py"), file("module.py")])).toBe(false);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([file("module.py"), file("MODULE.py")])).toBe(false);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([file("parent"), file("parent/child.py")])).toBe(false);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([directory("parent"), file("parent/child.py")])).toBe(true);
    expect(isHermesSourceSnapshotGcNodeInventoryWithinLimits([file("parent/child.py")])).toBe(false);
  });

  it("rejects aggregate path bytes above the fixed intent and native inventory budgets", () => {
    const paths = Array.from({ length: 30_000 }, (_, index) => `d${index.toString().padStart(5, "0")}/${"界".repeat(100)}`);
    expect(() => assertHermesSourceSnapshotGcTreeFits(paths)).toThrow(/path budget/u);
  });
});
