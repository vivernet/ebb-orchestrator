/** Resource limits shared by snapshot publication, durable GC recovery, and the native remover. */
export const HERMES_SOURCE_SNAPSHOT_GC_LIMITS = Object.freeze({
  intentBytes: 64 * 1024 * 1024,
  inventoryBytes: 64 * 1024 * 1024,
  files: 100_000,
  directories: 100_000,
  nodes: 200_000,
  pathBytes: 720,
  aggregatePathBytes: 8 * 1024 * 1024,
  identityDigits: 24,
});

/** Applies the filesystem component unit used by each supported operating system. */
export function assertHermesSourceRelativePathFits(path: string, platform: NodeJS.Platform = process.platform): void {
  if (!path || !path.isWellFormed() || Buffer.byteLength(path, "utf8") > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.pathBytes) {
    throw new Error("Hermes source path exceeds the GC representation byte limit");
  }
  if (platform === "win32" && path.length > 240) throw new Error("Hermes source path exceeds the Windows UTF-16 path limit");
  for (const segment of path.split("/")) {
    const size = platform === "win32" ? segment.length : Buffer.byteLength(segment, "utf8");
    if (size > 255) throw new Error(platform === "win32" ? "Windows component exceeds 255 UTF-16 units" : "POSIX component exceeds NAME_MAX (255 bytes)");
  }
}

/** Shared producer/recovery path contract, including portable Windows names and source-tree exclusions. */
export function isHermesSourceSnapshotRelativePathValid(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    assertHermesSourceRelativePathFits(path, platform);
  } catch {
    return false;
  }
  if (!path || path.startsWith("/") || path.includes("\\") || win32.isAbsolute(path) ||
      hasForbiddenPathCharacter(path) || path.endsWith(".") || path.endsWith(" ")) return false;
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.endsWith(".") || segment.endsWith(" ") ||
        /^\.git$/iu.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(segment)) return false;
  }
  return true;
}

function hasForbiddenPathCharacter(path: string): boolean {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f || '<>:"|?*'.includes(character))) return true;
  }
  return false;
}

/** Checks the persisted limit using the same node-count contract as publication and native inventory. */
export function assertHermesSourceSnapshotGcIntentFits(intentBytes: number, nodeCount: number): void {
  if (!Number.isSafeInteger(intentBytes) || intentBytes < 0 || intentBytes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.intentBytes ||
      !Number.isSafeInteger(nodeCount) || nodeCount < 0 || nodeCount > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.nodes) {
    throw new Error("Hermes source snapshot GC intent exceeds its supported byte or node budget");
  }
}

/** Applies producer limits when parsing a durable inventory before any cleanup can start. */
export function isHermesSourceSnapshotGcNodeInventoryWithinLimits(nodes: readonly unknown[]): boolean {
  if (nodes.length > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.nodes) return false;
  let files = 0;
  let directories = 0;
  let aggregatePathBytes = 0;
  const exactPaths = new Map<string, "file" | "directory">();
  const foldedPaths = new Set<string>();
  for (const candidate of nodes) {
    if (candidate === null || typeof candidate !== "object") return false;
    const node = candidate as Record<string, unknown>;
    if (node.kind === "file") files += 1;
    else if (node.kind === "directory") directories += 1;
    else return false;
    if (files > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.files || directories > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.directories ||
        typeof node.path !== "string" || !isHermesSourceSnapshotRelativePathValid(node.path)) return false;
    if (exactPaths.has(node.path)) return false;
    const foldedPath = node.path.normalize("NFC").toLowerCase();
    if (foldedPaths.has(foldedPath)) return false;
    exactPaths.set(node.path, node.kind);
    foldedPaths.add(foldedPath);
    aggregatePathBytes += Buffer.byteLength(node.path, "utf8");
    if (aggregatePathBytes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.aggregatePathBytes) return false;
  }
  for (const path of exactPaths.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = exactPaths.get(segments.slice(0, index).join("/"));
      if (parent !== "directory") return false;
    }
  }
  return true;
}

const INTENT_FIXED_BYTES_RESERVE = 4 * 1024;
const INVENTORY_FIXED_ROW_BYTES = 64;

/** Rejects a pinned tree before publication unless every future GC representation fits fixed budgets. */
export function assertHermesSourceSnapshotGcTreeFits(paths: readonly string[]): void {
  const directories = new Set<string>();
  const allPaths = new Set<string>();
  const pathKinds = new Map<string, "file" | "directory">();
  let aggregatePathBytes = 0;
  let nodeJsonBytes = 0;
  for (const path of paths) {
    addPath(path, "file");
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
      if (directories.size > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.directories) throw new Error("Hermes source tree exceeds the supported snapshot GC directory budget");
    }
  }
  if (paths.length > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.files) throw new Error("Hermes source tree exceeds the supported snapshot GC file budget");
  if (directories.size + paths.length > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.nodes) throw new Error("Hermes source tree exceeds the supported snapshot GC node budget");
  for (const path of directories) addPath(path, "directory");

  const nodes = allPaths.size;
  const inventoryUpperBound = 4 * 1024 + aggregatePathBytes + nodes * INVENTORY_FIXED_ROW_BYTES;
  const intentUpperBound = INTENT_FIXED_BYTES_RESERVE + nodeJsonBytes + Math.max(0, nodes - 1);
  if (nodes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.nodes ||
      aggregatePathBytes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.aggregatePathBytes ||
      inventoryUpperBound > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.inventoryBytes ||
      intentUpperBound > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.intentBytes) {
    throw new Error("Hermes source tree exceeds the supported snapshot GC resource budget");
  }

  function addPath(path: string, kind: "file" | "directory"): void {
    const existingKind = pathKinds.get(path);
    if (existingKind) {
      if (existingKind !== kind) throw new Error("Hermes source tree contains a file/directory path collision");
      return;
    }
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (pathBytes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.pathBytes) {
      throw new Error("Hermes source path exceeds the supported snapshot GC resource budget");
    }
    allPaths.add(path);
    pathKinds.set(path, kind);
    aggregatePathBytes += pathBytes;
    if (aggregatePathBytes > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.aggregatePathBytes) {
      throw new Error("Hermes source tree exceeds the supported snapshot GC path budget");
    }
    const quotedPath = JSON.stringify(path);
    const identity = `"dev":"${"9".repeat(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.identityDigits)}","ino":"${"9".repeat(HERMES_SOURCE_SNAPSHOT_GC_LIMITS.identityDigits)}"`;
    const row = kind === "directory"
      ? `{"identity":{${identity}},"kind":"directory","mode":null,"modeBits":365,"path":${quotedPath},"sha256":null}`
      : `{"identity":{${identity}},"kind":"file","mode":"100755","modeBits":365,"path":${quotedPath},"sha256":"${"f".repeat(64)}"}`;
    nodeJsonBytes += Buffer.byteLength(row, "utf8");
  }
}
import { win32 } from "node:path";
