import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, statfs, unlink, type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireHermesSourcePublicationLock, type HermesSourcePublicationLease, type HermesSourcePublicationLock } from "./hermes-source-publication-lock.js";
import { acquireHermesSourceReferenceLock, type HermesSourceReferenceLease } from "./hermes-source-reference-lock.js";
import {
  assertHermesSourceSnapshotGcIntentFits,
  assertHermesSourceSnapshotGcTreeFits, HERMES_SOURCE_SNAPSHOT_GC_LIMITS,
  isHermesSourceSnapshotGcNodeInventoryWithinLimits, isHermesSourceSnapshotRelativePathValid,
} from "./hermes-source-snapshot-gc-limits.js";
import { runVerifiedNativeHelper } from "../../../platform/process/native-helper-launcher.js";
import {
  markHermesSourceSnapshotDiagnosticPhase,
  reportHermesSourceSnapshotFailurePhase,
} from "./hermes-source-snapshot-diagnostics.js";

const IDENTITY_FORMAT_VERSION = 1;
const MANIFEST_FORMAT_VERSION = 1;
const MAX_TREE_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_PROJECTION_BYTES = 64 * 1024 * 1024;
const MAX_FILE_COUNT = HERMES_SOURCE_SNAPSHOT_GC_LIMITS.files;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MIN_DISK_RESERVE_BYTES = 16 * 1024 * 1024;
const DISK_RESERVE_RATIO = 0.1;
const HASH_HEX = /^[0-9a-f]+$/u;
const SNAPSHOT_ERROR_CODE = "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" as const;
const verifiedSnapshots = new WeakSet<object>();
const snapshotReferenceLeases = new WeakMap<object, HermesSourceReferenceLease>();

/** Точная идентичность Hermes source, привязанная к локальному commit и tree. */
export interface HermesSourceSnapshotRequest {
  /** Проверенный Git executable; вызовы выполняются напрямую с shell:false. */
  readonly gitExecutable: string;
  /** Локальный Hermes checkout с Git object database. Рабочее дерево не копируется. */
  readonly sourceRoot: string;
  /** Orchestrator-managed cache root для snapshot и sidecar metadata. */
  readonly cacheRoot: string;
  /** Точная строка из version-pinned Hermes resolver без нормализации. */
  readonly hermesVersion: string;
  /** Полный object ID pinned commit в lowercase hexadecimal. */
  readonly commit: string;
  /** Полный object ID ожидаемого Git tree в lowercase hexadecimal. */
  readonly tree: string;
  /** Trusted internal lease seam; production default проверяет native ОС authority. */
  readonly publicationLock?: HermesSourcePublicationLock;
  /** Trusted internal seam for OS held read/write leases over pending and live Run references. */
  readonly referenceLock?: (input: { cacheRoot: string; mode: "shared" | "exclusive" }) => Promise<HermesSourceReferenceLease>;
  /** Retains a reference lease until the caller durably inserts the Run process owner. */
  readonly retainReferenceLease?: boolean;
  /** DB policy may authorize collecting the exact conflicting, unreferenced snapshot. */
  readonly mayCollectSnapshot?: (cacheKey: string) => Promise<boolean>;
  /** Durable DB evidence that an exact legacy cache key is still referenced by a Run. */
  readonly hasSnapshotReferences?: (cacheKey: string) => Promise<boolean>;
  /** Test seam; production always removes GC objects via verified descriptor-relative native handles. */
  readonly removeSnapshotTree?: (cacheRoot: string, intent: object) => Promise<void>;
}

/** Устойчивая привязка snapshot, сохраняемая у Run и восстанавливаемая после restart. */
export interface HermesSourceSnapshot {
  /** Canonical JCS identity string для durable source key. */
  readonly cacheKey: string;
  /** SHA-256 UTF-8 cacheKey, используемый как детерминированная папка. */
  readonly directoryId: string;
  /** SHA-256 canonical source manifest. */
  readonly manifestDigest: string;
  /** Абсолютный путь к полностью проверенному read-only source tree. */
  readonly rootPath: string;
}

/** Deterministic native-helper metadata file emitted from the same canonical cache manifest. */
export interface HermesSourceSnapshotNativeProjection {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/** Проверяет opaque provenance: snapshot может создавать только этот модуль после полной верификации. */
export function isVerifiedHermesSourceSnapshot(value: unknown): value is HermesSourceSnapshot {
  return typeof value === "object" && value !== null && verifiedSnapshots.has(value);
}

/** Releases the cache reference held across Run preparation after durable owner binding. */
export async function releaseHermesSourceSnapshotReferenceLease(snapshot: HermesSourceSnapshot): Promise<void> {
  const lease = snapshotReferenceLeases.get(snapshot);
  if (!lease) return;
  snapshotReferenceLeases.delete(snapshot);
  await lease.release();
}

/**
 * Стабильная fail-closed ошибка source prerequisite без раскрытия Git stderr и filesystem paths.
 * Вызывающая сторона запрещает создание Run/manifest и запуск Hermes при этой ошибке.
 */
export class HermesSourceSnapshotError extends Error {
  /** Машинный код недоступного или не прошедшего проверку snapshot. */
  readonly code = SNAPSHOT_ERROR_CODE;
  constructor() {
    super(SNAPSHOT_ERROR_CODE);
    this.name = "HermesSourceSnapshotError";
  }
}

interface ManifestEntry {
  readonly mode: "100644" | "100755";
  readonly path: string;
  readonly sha256: string;
}
interface SnapshotManifest {
  readonly files: readonly ManifestEntry[];
  readonly formatVersion: typeof MANIFEST_FORMAT_VERSION;
}
interface SnapshotIdentity {
  readonly formatVersion: typeof IDENTITY_FORMAT_VERSION;
  readonly hermesVersion: string;
  readonly manifestDigest: string;
  readonly materializationPolicyVersion?: 2;
  readonly sourceCommit: string;
  readonly sourceTree: string;
}
interface SnapshotMetadata {
  readonly cacheKey: string;
  readonly identity: SnapshotIdentity;
  readonly manifest: SnapshotManifest;
}
interface SizedManifestEntry extends ManifestEntry {
  readonly size: number;
  readonly oid: string;
}
interface GitTreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
  readonly type: string;
}
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}
interface ExactFileIdentity {
  readonly dev: string;
  readonly ino: string;
}
interface SnapshotGcNode {
  readonly identity: ExactFileIdentity;
  readonly kind: "directory" | "file";
  readonly mode: "100644" | "100755" | null;
  readonly modeBits: number;
  readonly path: string;
  readonly sha256: string | null;
}
interface SnapshotGcIntent {
  readonly cacheKey: string;
  readonly directoryId: string;
  readonly formatVersion: 1;
  readonly manifestDigest: string;
  readonly metadataIdentity: ExactFileIdentity;
  readonly metadataSha256: string;
  readonly nodes: readonly SnapshotGcNode[];
  readonly projectionIdentity: ExactFileIdentity | null;
  readonly projectionSha256: string | null;
  readonly rootIdentity: ExactFileIdentity;
}

/**
 * Готовит общий content-addressed Hermes source snapshot из точного локального Git tree.
 *
 * Для cache miss читает commit/tree/blob objects напрямую через локальный Git без archive,
 * network, working-tree read или чтения Hermes configuration/auth данных. До возврата выполняет
 * повторную проверку опубликованного дерева; вызывающая сторона может только после этого начинать
 * Run/manifest transaction. Ошибка, включая нехватку диска, всегда fail-closed.
 *
 * @param request Проверенные Git и cache пути плюс точная pinned source identity.
 * @returns Durable key, детерминированный каталог, manifest digest и полностью проверенный root.
 * @throws {HermesSourceSnapshotError} Если source/cache identity, объекты, пути, лимиты или IO
 * нарушают контракт; текст ошибки не раскрывает filesystem paths или Git stderr.
 */
export async function materializeHermesSourceSnapshot(request: HermesSourceSnapshotRequest): Promise<HermesSourceSnapshot> {
  let lease: HermesSourcePublicationLease | undefined;
  let referenceLease: HermesSourceReferenceLease | undefined;
  let retainReferenceLease = false;
  try {
    markHermesSourceSnapshotDiagnosticPhase("validate");
    validateRequest(request);
    const sourceRoot = await validateManagedDirectory(request.sourceRoot, false);
    const cacheRoot = await validateManagedDirectory(request.cacheRoot, true, true);
    markHermesSourceSnapshotDiagnosticPhase("reference-lock");
    referenceLease = await (request.referenceLock ?? acquireHermesSourceReferenceLock)({ cacheRoot, mode: "shared" });
    referenceLease.assertHeld();
    markHermesSourceSnapshotDiagnosticPhase("publication-lock");
    lease = await (request.publicationLock ?? acquireHermesSourcePublicationLock)({ cacheRoot });
    lease.assertHeld();
    markHermesSourceSnapshotDiagnosticPhase("source-git");
    const resolvedTree = await resolveCommitTree(request.gitExecutable, sourceRoot, request.commit);
    if (resolvedTree !== request.tree) throw snapshotError();
    const entries = await listPinnedTree(request.gitExecutable, sourceRoot, request.commit);
    validateTreeEntries(entries);
    const sizedEntries = await readAndHashGitBlobs(request.gitExecutable, sourceRoot, entries);
    const manifest = makeManifest(sizedEntries);
    const manifestDigest = sha256(canonicalJson(manifest));
    const identity: SnapshotIdentity = {
      formatVersion: IDENTITY_FORMAT_VERSION,
      hermesVersion: request.hermesVersion,
      manifestDigest,
      ...(process.platform === "win32" ? { materializationPolicyVersion: 2 as const } : {}),
      sourceCommit: request.commit,
      sourceTree: request.tree,
    };
    const cacheKey = canonicalJson(identity);
    const directoryId = sha256(cacheKey);
    const finalPath = join(cacheRoot, directoryId);
    const metadataPath = metadataPathFor(cacheRoot, directoryId);
    markHermesSourceSnapshotDiagnosticPhase("snapshot-publish");
    let existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
      if (existing && await pathExists(snapshotGcIntentPath(cacheRoot, directoryId))) {
        await releaseSnapshotLease(lease);
        lease = undefined;
        await releaseSourceReferenceLease(referenceLease);
        referenceLease = undefined;
        referenceLease = await (request.referenceLock ?? acquireHermesSourceReferenceLock)({ cacheRoot, mode: "exclusive" });
        referenceLease.assertHeld();
        lease = await (request.publicationLock ?? acquireHermesSourcePublicationLock)({ cacheRoot });
        lease.assertHeld();
        await resumeSnapshotGcIntents(cacheRoot, request.mayCollectSnapshot, request.removeSnapshotTree);
        existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      }
      if (existing) {
        await recoverStagingArtifacts(cacheRoot);
        const snapshot = await lookupExpectedSnapshot(cacheRoot, cacheKey, metadataPath, finalPath, identity, manifest);
        markHermesSourceSnapshotDiagnosticPhase("native-projection");
        await ensureNativeProjection(cacheRoot, snapshot, manifest);
        retainReferenceLease = request.retainReferenceLease === true;
        return retainSnapshotReferenceLease(snapshot, referenceLease, retainReferenceLease);
      }

    await assertAvailableSpace(cacheRoot, totalBytes(sizedEntries));

    let stagingPath: string | undefined;
    let stagingIdentity: FileIdentity | ExactFileIdentity | undefined;
    let stagingNonce: string | undefined;
    try {
      const raced = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (raced) {
        await recoverStagingArtifacts(cacheRoot);
        const snapshot = await lookupExpectedSnapshot(cacheRoot, cacheKey, metadataPath, finalPath, identity, manifest);
        markHermesSourceSnapshotDiagnosticPhase("native-projection");
        await ensureNativeProjection(cacheRoot, snapshot, manifest);
        retainReferenceLease = request.retainReferenceLease === true;
        return retainSnapshotReferenceLease(snapshot, referenceLease, retainReferenceLease);
      }

      await releaseSnapshotLease(lease);
      lease = undefined;
      await releaseSourceReferenceLease(referenceLease);
      referenceLease = undefined;
      referenceLease = await (request.referenceLock ?? acquireHermesSourceReferenceLock)({ cacheRoot, mode: "exclusive" });
      referenceLease.assertHeld();
      lease = await (request.publicationLock ?? acquireHermesSourcePublicationLock)({ cacheRoot });
      lease.assertHeld();
      const appeared = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (appeared) {
        await recoverStagingArtifacts(cacheRoot);
        const snapshot = await lookupExpectedSnapshot(cacheRoot, cacheKey, metadataPath, finalPath, identity, manifest);
        markHermesSourceSnapshotDiagnosticPhase("native-projection");
        await ensureNativeProjection(cacheRoot, snapshot, manifest);
        retainReferenceLease = request.retainReferenceLease === true;
        return retainSnapshotReferenceLease(snapshot, referenceLease, retainReferenceLease);
      }

      lease.assertHeld();
      await recoverStagingArtifacts(cacheRoot);
      const preservedLegacySnapshots = await collectConflictingSnapshot(
        cacheRoot, directoryId, identity, request.mayCollectSnapshot, request.hasSnapshotReferences, request.removeSnapshotTree,
      );
      await assertSingleSnapshot(cacheRoot, directoryId, preservedLegacySnapshots);
      await assertNoUnresolvedStaging(cacheRoot);
      await assertAvailableSpace(cacheRoot, totalBytes(sizedEntries));
      lease.assertHeld();
      stagingNonce = randomUUID();
      stagingPath = join(cacheRoot, ".staging-" + directoryId + "-" + stagingNonce);
      stagingIdentity = await createSnapshotStagingDirectory(cacheRoot, stagingPath);
      await writeStagingOwner(stagingPath, directoryId, stagingNonce, stagingIdentity);
      await createSnapshotDirectoryTree(stagingPath, manifest);
      const materialized = await readAndHashGitBlobs(request.gitExecutable, sourceRoot, entries, {
        root: stagingPath,
        expected: sizedEntries,
      });
      if (!sameManifest(manifest, makeManifest(materialized))) throw snapshotError();
      await assertSourceTreeUnchanged(request.gitExecutable, sourceRoot, request.commit, request.tree);
      await sealSnapshotTree(stagingPath, manifest);
      await verifySnapshotTree(stagingPath, manifest);
      lease.assertHeld();
      await persistSnapshotMetadata(cacheRoot, metadataPath, directoryId, { cacheKey, identity, manifest });

      // В приватном managed root общий lock исключает competing publishers. Проверка
      // существования запрещает replacement; rename публикует только полностью готовое дерево.
      if (await pathExists(finalPath)) throw snapshotError();
      await syncDirectory(cacheRoot);
      lease.assertHeld();
      await assertStagingIdentity(stagingPath, stagingIdentity);
      await rename(stagingPath, finalPath);
      await assertSnapshotRootIdentity(finalPath, stagingIdentity);
      await removeStagingOwner(stagingPath, stagingIdentity, finalPath);
      stagingPath = undefined;
      await syncDirectory(cacheRoot);
      const result = snapshotResult(cacheRoot, cacheKey, directoryId, manifestDigest);
      await verifySnapshotTree(result.rootPath, manifest);
      markHermesSourceSnapshotDiagnosticPhase("native-projection");
      await ensureNativeProjection(cacheRoot, result, manifest);
      lease.assertHeld();
      retainReferenceLease = request.retainReferenceLease === true;
      return retainSnapshotReferenceLease(result, referenceLease, retainReferenceLease);
    } catch (error) {
      if (stagingPath && stagingIdentity && stagingNonce) {
        if (!lease) throw snapshotError();
        lease.assertHeld();
        await removeOwnedStagingTree(cacheRoot, stagingPath, directoryId, stagingNonce, stagingIdentity).catch(() => undefined);
      }
      throw error;
    }
  } catch {
    reportHermesSourceSnapshotFailurePhase();
    throw snapshotError();
  } finally {
    try {
      await releaseSnapshotLease(lease);
    } finally {
      if (!retainReferenceLease) await releaseSourceReferenceLease(referenceLease);
    }
  }
}

function retainSnapshotReferenceLease(
  snapshot: HermesSourceSnapshot,
  lease: HermesSourceReferenceLease | undefined,
  retain: boolean,
): HermesSourceSnapshot {
  if (!lease) throw snapshotError();
  lease.assertHeld();
  if (retain) {
    snapshotReferenceLeases.set(snapshot, lease);
    return snapshot;
  }
  // Non-Run callers release in the enclosing materialization finally block.
  return snapshot;
}

async function releaseSourceReferenceLease(lease: HermesSourceReferenceLease | undefined): Promise<void> {
  try { await lease?.release(); } catch { throw snapshotError(); }
}

/**
 * Восстанавливает entry по durable canonical key, проверяя sidecar и каждый фактический файл.
 *
 * Git, Hermes runtime, provider/auth configuration и source installation здесь не читаются: key
 * вместе с sidecar задаёт ожидаемый source manifest, а реальные байты snapshot повторно хешируются.
 * Любое расхождение запрещает resume; entry не заменяется новой установленной версией.
 *
 * @param input Cache root и ровно тот key, который был сохранён у Run.
 * @param input.cacheRoot Приватный runtime cache root Orchestrator.
 * @param input.cacheKey Durable canonical key исходного Run без замены текущей версией.
 * @param input.publicationLock Trusted internal test seam; по умолчанию verified native lease.
 * @returns Snapshot с восстановленным deterministic root path после полной revalidation.
 * @throws {HermesSourceSnapshotError} Если key или опубликованный snapshot невалиден/недоступен.
 */
export async function lookupHermesSourceSnapshot(input: {
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly publicationLock?: HermesSourcePublicationLock;
}): Promise<HermesSourceSnapshot> {
  let lease: HermesSourcePublicationLease | undefined;
  try {
    if (typeof input.cacheKey !== "string" || input.cacheKey.length < 2 || input.cacheKey.length > MAX_MANIFEST_BYTES) {
      throw snapshotError();
    }
    const cacheRoot = await validateManagedDirectory(input.cacheRoot, false, true);
    lease = await (input.publicationLock ?? acquireHermesSourcePublicationLock)({ cacheRoot });
    lease.assertHeld();
    const metadata = await readSnapshotMetadata(cacheRoot, input.cacheKey);
    const parsed = validateMetadataAndKey(metadata, input.cacheKey);
    const result = snapshotResult(cacheRoot, input.cacheKey, parsed.directoryId, parsed.identity.manifestDigest);
    await verifySnapshotTree(result.rootPath, parsed.manifest);
    await ensureNativeProjection(cacheRoot, result, parsed.manifest);
    lease.assertHeld();
    return result;
  } catch {
    throw snapshotError();
  } finally {
    await releaseSnapshotLease(lease);
  }
}

/**
 * Возвращает устойчивую native projection sidecar для уже опубликованного snapshot.
 *
 * Проекция формируется из canonical manifest cache entry, публикуется атомарно рядом с ним и
 * полностью проверяется под тем же publication lease. Это bounded ABI file для последующего
 * native launcher; сериализованные байты не протаскиваются через process argv/frame.
 *
 * @param input Точный cache key исходного Run и managed cache root.
 * @param input.cacheRoot Приватный runtime cache root Orchestrator.
 * @param input.cacheKey Durable canonical key исходного Run без замены текущей версией.
 * @param input.publicationLock Trusted internal test seam; по умолчанию verified native lease.
 * @returns Original snapshot плюс путь, SHA-256 и размер версии ABI.
 * @throws {HermesSourceSnapshotError} Если исходный snapshot или projection не прошли проверку.
 */
export async function ensureHermesSourceSnapshotNativeProjection(input: {
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly publicationLock?: HermesSourcePublicationLock;
}): Promise<{ readonly snapshot: HermesSourceSnapshot; readonly projection: HermesSourceSnapshotNativeProjection }> {
  let lease: HermesSourcePublicationLease | undefined;
  try {
    if (typeof input.cacheKey !== "string" || input.cacheKey.length < 2 || input.cacheKey.length > MAX_MANIFEST_BYTES) throw snapshotError();
    const cacheRoot = await validateManagedDirectory(input.cacheRoot, false, true);
    lease = await (input.publicationLock ?? acquireHermesSourcePublicationLock)({ cacheRoot });
    lease.assertHeld();
    const metadata = await readSnapshotMetadata(cacheRoot, input.cacheKey);
    const parsed = validateMetadataAndKey(metadata, input.cacheKey);
    const snapshot = snapshotResult(cacheRoot, input.cacheKey, parsed.directoryId, parsed.identity.manifestDigest);
    await verifySnapshotTree(snapshot.rootPath, parsed.manifest);
    const projection = await ensureNativeProjection(cacheRoot, snapshot, parsed.manifest);
    lease.assertHeld();
    return { snapshot, projection };
  } catch {
    throw snapshotError();
  } finally {
    await releaseSnapshotLease(lease);
  }
}

function validateRequest(request: HermesSourceSnapshotRequest): void {
  if (!request || typeof request !== "object" ||
      typeof request.gitExecutable !== "string" || request.gitExecutable.length === 0 ||
      typeof request.sourceRoot !== "string" || !isAbsolute(request.sourceRoot) ||
      typeof request.cacheRoot !== "string" || !isAbsolute(request.cacheRoot) ||
      typeof request.hermesVersion !== "string" || request.hermesVersion.length === 0 ||
      request.hermesVersion.length > 256 || !request.hermesVersion.isWellFormed() || hasControlCharacter(request.hermesVersion) ||
      !isGitObjectId(request.commit) || !isGitObjectId(request.tree) || request.commit.length !== request.tree.length) {
    throw snapshotError();
  }
}

async function releaseSnapshotLease(lease: HermesSourcePublicationLease | undefined): Promise<void> {
  try { await lease?.release(); } catch { throw snapshotError(); }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && (value.length === 40 || value.length === 64) && HASH_HEX.test(value);
}

async function validateManagedDirectory(value: string, create: boolean, privateRoot = false): Promise<string> {
  const absolute = resolve(value);
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 });
  const details = await lstat(absolute);
  if (!details.isDirectory() || details.isSymbolicLink()) throw snapshotError();
  if (privateRoot && process.platform !== "win32" &&
      ((details.mode & 0o777) !== 0o700 || details.uid !== process.getuid?.())) throw snapshotError();
  const canonical = await realpath(absolute);
  if (!sameHostPath(absolute, canonical)) throw snapshotError();
  return canonical;
}

async function resolveCommitTree(git: string, sourceRoot: string, commit: string): Promise<string> {
  const type = (await captureGit(git, sourceRoot, ["cat-file", "-t", commit], 128)).trim();
  if (type !== "commit") throw snapshotError();
  const result = (await captureGit(git, sourceRoot, ["rev-parse", "--verify", "--end-of-options", commit + "^{tree}"], 256)).trim();
  if (!isGitObjectId(result) || result.length !== commit.length) throw snapshotError();
  return result;
}

async function assertSourceTreeUnchanged(git: string, sourceRoot: string, commit: string, expectedTree: string): Promise<void> {
  if (await resolveCommitTree(git, sourceRoot, commit) !== expectedTree) throw snapshotError();
}

async function listPinnedTree(git: string, sourceRoot: string, commit: string): Promise<GitTreeEntry[]> {
  const output = await captureGitBytes(git, sourceRoot, ["ls-tree", "-r", "-z", "--full-tree", commit], MAX_TREE_OUTPUT_BYTES);
  const entries: GitTreeEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) throw snapshotError();
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0 || tab === record.length - 1) throw snapshotError();
    const prefix = record.subarray(0, tab).toString("ascii");
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(prefix);
    if (!match) throw snapshotError();
    let relativePath: string;
    try {
      relativePath = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(tab + 1));
    } catch {
      throw snapshotError();
    }
    entries.push({ mode: match[1]!, type: match[2]!, oid: match[3]!, path: relativePath });
    if (entries.length > MAX_FILE_COUNT) throw snapshotError();
  }
  if (output.length > 0 && output[output.length - 1] !== 0) throw snapshotError();
  return entries;
}

function validateTreeEntries(entries: GitTreeEntry[]): void {
  if (entries.length === 0 || entries.length > MAX_FILE_COUNT) throw snapshotError();
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const entry of entries) {
    validateRelativePath(entry.path);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || !isGitObjectId(entry.oid)) {
      throw snapshotError();
    }
    const foldedPath = entry.path.normalize("NFC").toLowerCase();
    if (exact.has(entry.path) || folded.has(foldedPath)) throw snapshotError();
    exact.add(entry.path);
    folded.add(foldedPath);
  }
  try {
    assertHermesSourceSnapshotGcTreeFits(entries.map((entry) => entry.path));
  } catch {
    throw snapshotError();
  }
  entries.sort((left, right) => compareUtf8(left.path, right.path));
}

function validateRelativePath(value: string): void {
  if (!isHermesSourceSnapshotRelativePathValid(value)) throw snapshotError();
}

async function readAndHashGitBlobs(
  git: string,
  sourceRoot: string,
  entries: readonly GitTreeEntry[],
  materialize?: { readonly root: string; readonly expected: readonly SizedManifestEntry[] },
): Promise<SizedManifestEntry[]> {
  const results: SizedManifestEntry[] = [];
  const child = spawn(git, ["-C", sourceRoot, "cat-file", "--batch"], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: gitEnvironment(),
  });
  const reader = new AsyncByteReader(child.stdout);
  const stderr = collectBounded(child.stderr, 64 * 1024);
  const exit = observeChild(child);
  void exit.catch(() => terminateChild(child));
  void stderr.catch(() => terminateChild(child));
  const handles = new Set<FileHandle>();
  let total = 0;
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const expected = materialize?.expected[index];
      if (expected && (expected.path !== entry.path || expected.oid !== entry.oid || expected.mode !== entry.mode)) throw snapshotError();
      await writeLine(child, entry.oid + "\n");
      const header = (await reader.readLine(256)).toString("ascii");
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9][0-9]*)$/u.exec(header);
      if (!match || match[1] !== entry.oid) throw snapshotError();
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES || size < 0 || (expected && expected.size !== size)) throw snapshotError();
      total += size;
      if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) throw snapshotError();
      const hash = createHash("sha256");
      const objectHash = createHash(entry.oid.length === 40 ? "sha1" : "sha256");
      objectHash.update("blob " + size + "\0", "ascii");
      const target = materialize ? await createSnapshotFile(materialize.root, entry.path, handles) : undefined;
      await reader.consumeExactly(size, async (chunk) => {
        hash.update(chunk);
        objectHash.update(chunk);
        if (target) await writeAll(target, chunk);
      });
      if ((await reader.readExactly(1))[0] !== 0x0a) throw snapshotError();
      if (objectHash.digest("hex") !== entry.oid) throw snapshotError();
      const digest = hash.digest("hex");
      if (expected && digest !== expected.sha256) throw snapshotError();
      if (target) await finishSnapshotFile(target, entry.mode, handles);
      results.push({ mode: entry.mode as "100644" | "100755", path: entry.path, sha256: digest, oid: entry.oid, size });
    }
    child.stdin.end();
    await reader.assertEnd();
    const status = await exit;
    await stderr;
    if (status.code !== 0 || status.signal !== null) throw snapshotError();
    return results;
  } catch {
    terminateChild(child);
    await exit.catch(() => undefined);
    await stderr.catch(() => undefined);
    throw snapshotError();
  } finally {
    await Promise.allSettled([...handles].map((handle) => handle.close()));
  }
}

async function createSnapshotFile(stageRoot: string, relativePath: string, handles: Set<FileHandle>): Promise<FileHandle> {
  const absolute = join(stageRoot, ...relativePath.split("/"));
  const handle = await open(absolute, "wx", 0o600);
  handles.add(handle);
  return handle;
}

async function finishSnapshotFile(handle: FileHandle, sourceMode: string, handles: Set<FileHandle>): Promise<void> {
  const mode = sourceMode === "100755" ? 0o500 : 0o400;
  await handle.sync();
  await handle.chmod(mode);
  await handle.sync();
  await handle.close();
  handles.delete(handle);
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw snapshotError();
    offset += result.bytesWritten;
  }
}

async function createSnapshotDirectoryTree(stageRoot: string, manifest: SnapshotManifest): Promise<void> {
  const directories = new Set<string>();
  for (const entry of manifest.files) {
    const segments = entry.path.split("/");
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  }
  for (const path of [...directories].sort((left, right) => depth(left) - depth(right) || compareUtf8(left, right))) {
    await mkdir(join(stageRoot, ...path.split("/")), { mode: 0o700 });
  }
}

async function sealSnapshotTree(stageRoot: string, manifest: SnapshotManifest): Promise<void> {
  const directories = new Set<string>([""]);
  for (const entry of manifest.files) {
    const segments = entry.path.split("/");
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
  }
  const deepest = [...directories].sort((left, right) => depth(right) - depth(left) || compareUtf8(right, left));
  for (const directory of deepest) {
    const absolute = directory ? join(stageRoot, ...directory.split("/")) : stageRoot;
    await syncDirectory(absolute);
    await chmod(absolute, 0o500);
    await syncDirectory(absolute);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function makeManifest(entries: readonly SizedManifestEntry[]): SnapshotManifest {
  const files = entries.map(({ mode, path, sha256: digest }) => ({ mode, path, sha256: digest }));
  return { files, formatVersion: MANIFEST_FORMAT_VERSION };
}

function sameManifest(left: SnapshotManifest, right: SnapshotManifest): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

async function assertSingleSnapshot(cacheRoot: string, directoryId: string, preservedLegacySnapshots: ReadonlySet<string>): Promise<void> {
  let preservedCount = 0;
  for (const name of await readdir(cacheRoot)) {
    if (!/^[0-9a-f]{64}$/u.test(name) || name === directoryId) continue;
    if (!preservedLegacySnapshots.has(name) || ++preservedCount > 1) throw snapshotError();
  }
}

async function collectConflictingSnapshot(
  cacheRoot: string,
  requestedDirectoryId: string,
  requestedIdentity: SnapshotIdentity,
  mayCollectSnapshot: HermesSourceSnapshotRequest["mayCollectSnapshot"],
  hasSnapshotReferences: HermesSourceSnapshotRequest["hasSnapshotReferences"],
  removeSnapshotTree: HermesSourceSnapshotRequest["removeSnapshotTree"],
): Promise<ReadonlySet<string>> {
  const preservedLegacySnapshots = new Set<string>();
  await resumeSnapshotGcIntents(cacheRoot, mayCollectSnapshot, removeSnapshotTree);
  for (const name of await readdir(cacheRoot)) {
    if (!/^[0-9a-f]{64}$/u.test(name) || name === requestedDirectoryId) continue;
    const rootPath = join(cacheRoot, name);
    const rootBefore = await lstat(rootPath, { bigint: true });
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw snapshotError();
    const metadataPath = metadataPathFor(cacheRoot, name);
    const metadataBytes = await readStableFile(metadataPath, undefined, MAX_MANIFEST_BYTES);
    const metadataText = metadataBytes.toString("utf8");
    const metadata = JSON.parse(metadataText) as SnapshotMetadata;
    if (canonicalJson(metadata) !== metadataText) throw snapshotError();
    if (typeof metadata.cacheKey !== "string") throw snapshotError();
    const parsed = validateMetadataAndKey(metadata, metadata.cacheKey);
    if (parsed.directoryId !== name || sha256(metadata.cacheKey) !== name) throw snapshotError();
    const allowed = mayCollectSnapshot ? await mayCollectSnapshot(metadata.cacheKey) : undefined;
    if (allowed !== true && isReferencedLegacyWindowsSnapshot(parsed.identity, requestedIdentity)) {
      if (allowed !== false || !hasSnapshotReferences || await hasSnapshotReferences(metadata.cacheKey) !== true) throw snapshotError();
      await verifySnapshotTree(rootPath, parsed.manifest);
      preservedLegacySnapshots.add(name);
      continue;
    }
    if (allowed !== true) throw snapshotError();

    await verifySnapshotTree(rootPath, parsed.manifest);
    const rootAfterVerification = await lstat(rootPath, { bigint: true });
    if (!rootAfterVerification.isDirectory() || rootAfterVerification.isSymbolicLink() ||
        !sameExactFileIdentity(exactIdentityFromStats(rootBefore), exactIdentityFromStats(rootAfterVerification))) throw snapshotError();
    const projectionPath = nativeProjectionPathFor(cacheRoot, name);
    const projection = await lstat(projectionPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (projection) {
      if (!projection.isFile() || projection.isSymbolicLink()) throw snapshotError();
      const expected = encodeNativeProjection(snapshotResult(cacheRoot, metadata.cacheKey, name, parsed.identity.manifestDigest), parsed.manifest);
      const actual = await readStableFile(projectionPath, exactIdentityFromStats(projection), MAX_NATIVE_PROJECTION_BYTES);
      if (!actual.equals(expected)) throw snapshotError();
    }
    const metadataIdentity = exactIdentityFromStats(await lstat(metadataPath, { bigint: true }));
    await readStableFile(metadataPath, metadataIdentity, MAX_MANIFEST_BYTES);

    const root = await lstat(rootPath, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || !sameExactFileIdentity(exactIdentityFromStats(rootBefore), exactIdentityFromStats(root))) {
      throw snapshotError();
    }
    const intent: SnapshotGcIntent = {
      cacheKey: metadata.cacheKey,
      directoryId: name,
      formatVersion: 1,
      manifestDigest: parsed.identity.manifestDigest,
      metadataIdentity,
      metadataSha256: sha256(metadataBytes),
      nodes: await collectSnapshotGcNodes(rootPath, parsed.manifest),
      projectionIdentity: projection ? exactIdentityFromStats(projection) : null,
      projectionSha256: projection ? sha256(encodeNativeProjection(
        snapshotResult(cacheRoot, metadata.cacheKey, name, parsed.identity.manifestDigest), parsed.manifest,
      )) : null,
      rootIdentity: exactIdentityFromStats(rootBefore),
    };
    const intentPath = await persistSnapshotGcIntent(cacheRoot, intent);
    await finishSnapshotGc(cacheRoot, intent, intentPath, await lstat(intentPath, { bigint: true }).then(exactIdentityFromStats), removeSnapshotTree);
  }
  return preservedLegacySnapshots;
}

function isReferencedLegacyWindowsSnapshot(existing: SnapshotIdentity, requested: SnapshotIdentity): boolean {
  return process.platform === "win32" && requested.materializationPolicyVersion === 2 &&
    existing.materializationPolicyVersion === undefined && existing.formatVersion === requested.formatVersion &&
    existing.hermesVersion === requested.hermesVersion && existing.manifestDigest === requested.manifestDigest &&
    existing.sourceCommit === requested.sourceCommit && existing.sourceTree === requested.sourceTree;
}

/** Continues only durable, exact-key cleanup intents after reacquiring both cache locks. */
async function resumeSnapshotGcIntents(
  cacheRoot: string,
  mayCollectSnapshot: HermesSourceSnapshotRequest["mayCollectSnapshot"],
  removeSnapshotTree: HermesSourceSnapshotRequest["removeSnapshotTree"],
): Promise<void> {
  const names = await readdir(cacheRoot);
  for (const name of names) {
    if (!/^\.gc-[0-9a-f]{64}\.intent\.json\.tmp-[0-9a-f-]{36}$/u.test(name)) continue;
    const temporaryPath = join(cacheRoot, name);
    const before = await lstat(temporaryPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw snapshotError();
    const current = await lstat(temporaryPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() ||
        !sameExactFileIdentity(exactIdentityFromStats(before), exactIdentityFromStats(current))) throw snapshotError();
    await unlink(temporaryPath);
  }
  for (const name of names) {
    const match = /^\.gc-([0-9a-f]{64})\.intent\.json$/u.exec(name);
    if (!match) continue;
    const intentPath = join(cacheRoot, name);
    const intentDetails = await lstat(intentPath, { bigint: true });
    if (!intentDetails.isFile() || intentDetails.isSymbolicLink()) throw snapshotError();
    const intentIdentity = exactIdentityFromStats(intentDetails);
    const intentBytes = await readStableFile(intentPath, intentIdentity, HERMES_SOURCE_SNAPSHOT_GC_LIMITS.intentBytes);
    const intentText = intentBytes.toString("utf8");
    const intent = JSON.parse(intentText) as SnapshotGcIntent;
    if (canonicalJson(intent) !== intentText || !isSnapshotGcIntent(intent) || intent.directoryId !== match[1] ||
        sha256(intent.cacheKey) !== intent.directoryId) throw snapshotError();
    if (!mayCollectSnapshot || await mayCollectSnapshot(intent.cacheKey) !== true) throw snapshotError();
    await finishSnapshotGc(cacheRoot, intent, intentPath, intentIdentity, removeSnapshotTree);
  }
}

/** Writes a fully synced rename-published intent before the first destructive cleanup operation. */
async function persistSnapshotGcIntent(cacheRoot: string, intent: SnapshotGcIntent): Promise<string> {
  const finalPath = snapshotGcIntentPath(cacheRoot, intent.directoryId);
  if (await pathExists(finalPath)) throw snapshotError();
  const temporaryPath = finalPath + ".tmp-" + randomUUID();
  const bytes = Buffer.from(canonicalJson(intent), "utf8");
  try {
    assertHermesSourceSnapshotGcIntentFits(bytes.byteLength, intent.nodes.length);
  } catch {
    throw snapshotError();
  }
  const handle = await open(temporaryPath, "wx", 0o600);
  const temporaryIdentity = exactIdentityFromStats(await handle.stat({ bigint: true }));
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (await pathExists(finalPath)) {
    await removeGcTemporaryFile(temporaryPath, temporaryIdentity);
    throw snapshotError();
  }
  await rename(temporaryPath, finalPath);
  await syncDirectory(cacheRoot);
  return finalPath;
}

/** Resumes removal by the recorded object identities; every sidecar may already be absent. */
async function finishSnapshotGc(
  cacheRoot: string,
  intent: SnapshotGcIntent,
  intentPath: string,
  intentIdentity: ExactFileIdentity,
  removeSnapshotTree: HermesSourceSnapshotRequest["removeSnapshotTree"],
): Promise<void> {
  if (!isSnapshotGcIntent(intent) || sha256(intent.cacheKey) !== intent.directoryId ||
      intentPath !== snapshotGcIntentPath(cacheRoot, intent.directoryId)) throw snapshotError();
  const metadataPath = metadataPathFor(cacheRoot, intent.directoryId);
  const metadata = await lstat(metadataPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata) {
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        !sameExactFileIdentity(intent.metadataIdentity, exactIdentityFromStats(metadata))) throw snapshotError();
    const bytes = await readStableFile(metadataPath, intent.metadataIdentity, MAX_MANIFEST_BYTES);
    if (sha256(bytes) !== intent.metadataSha256) throw snapshotError();
    const text = bytes.toString("utf8");
    const value = JSON.parse(text) as SnapshotMetadata;
    if (canonicalJson(value) !== text || value.cacheKey !== intent.cacheKey) throw snapshotError();
    const parsed = validateMetadataAndKey(value, intent.cacheKey);
    if (parsed.directoryId !== intent.directoryId || parsed.identity.manifestDigest !== intent.manifestDigest) throw snapshotError();
    assertGcNodesMatchManifest(intent.nodes, parsed.manifest);
  }

  const projectionPath = nativeProjectionPathFor(cacheRoot, intent.directoryId);
  const projection = await lstat(projectionPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (projection) {
    if (!intent.projectionIdentity || !projection.isFile() || projection.isSymbolicLink() ||
        !sameExactFileIdentity(intent.projectionIdentity, exactIdentityFromStats(projection))) throw snapshotError();
    const bytes = await readStableFile(projectionPath, intent.projectionIdentity, MAX_NATIVE_PROJECTION_BYTES);
    if (sha256(bytes) !== intent.projectionSha256) throw snapshotError();
  }

  const rootPath = join(cacheRoot, intent.directoryId);
  const root = await lstat(rootPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (root) {
    if (!root.isDirectory() || root.isSymbolicLink() || !sameExactFileIdentity(intent.rootIdentity, exactIdentityFromStats(root))) throw snapshotError();
    if (!metadata || !projection) throw snapshotError();
    await verifySnapshotGcSurvivors(rootPath, intent.nodes);
  }
  if (!root && metadata && !projection) throw snapshotError();
  const currentIntent = await lstat(intentPath, { bigint: true });
  if (!currentIntent.isFile() || currentIntent.isSymbolicLink() || !sameExactFileIdentity(intentIdentity, exactIdentityFromStats(currentIntent))) throw snapshotError();
  if (removeSnapshotTree) await removeSnapshotTree(cacheRoot, intent);
  else await removeSnapshotGcTreeByVerifiedNativeHandles(cacheRoot, intent, intentIdentity, metadata !== undefined,
    projection !== undefined);
  await syncDirectory(cacheRoot);
}

/** Deletes only intent-bound objects through the verified native helper while caller holds both EX leases. */
async function removeSnapshotGcTreeByVerifiedNativeHandles(
  cacheRoot: string,
  intent: SnapshotGcIntent,
  intentIdentity: ExactFileIdentity,
  metadataPresent: boolean,
  projectionPresent: boolean,
): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "linux") throw snapshotError();
  const rows = [`ROOT\t${intent.rootIdentity.dev}\t${intent.rootIdentity.ino}`];
  for (const node of intent.nodes) rows.push(`${node.kind}\t${node.identity.dev}\t${node.identity.ino}\t${node.path}`);
  if (metadataPresent) rows.push(`sidecar\t${intent.metadataIdentity.dev}\t${intent.metadataIdentity.ino}\t${basename(metadataPathFor(cacheRoot, intent.directoryId))}`);
  if (projectionPresent && intent.projectionIdentity) rows.push(`sidecar\t${intent.projectionIdentity.dev}\t${intent.projectionIdentity.ino}\t${basename(nativeProjectionPathFor(cacheRoot, intent.directoryId))}`);
  rows.push(`sidecar\t${intentIdentity.dev}\t${intentIdentity.ino}\t${basename(snapshotGcIntentPath(cacheRoot, intent.directoryId))}`);
  const inventory = rows.join("\n") + "\n";
  if (Buffer.byteLength(inventory, "utf8") > HERMES_SOURCE_SNAPSHOT_GC_LIMITS.inventoryBytes) throw snapshotError();
  const helperPath = fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/" +
    (process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path"), import.meta.url));
  await runVerifiedNativeHelper(helperPath, "hermesProfilePath", ["source-cache-gc-remove", cacheRoot, intent.directoryId], {
    env: {}, input: inventory, maxBuffer: 1024, timeout: 120_000,
  });
}

function isSnapshotGcIntent(value: unknown): value is SnapshotGcIntent {
  if (value === null || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  const identity = (candidate: unknown): candidate is ExactFileIdentity => typeof candidate === "object" && candidate !== null &&
    typeof (candidate as Record<string, unknown>).dev === "string" && /^(?:0|[1-9]\d{0,23})$/u.test((candidate as Record<string, unknown>).dev as string) &&
    typeof (candidate as Record<string, unknown>).ino === "string" && /^(?:0|[1-9]\d{0,23})$/u.test((candidate as Record<string, unknown>).ino as string);
  return intent.formatVersion === 1 && typeof intent.cacheKey === "string" && intent.cacheKey.length > 0 &&
    typeof intent.directoryId === "string" && /^[0-9a-f]{64}$/u.test(intent.directoryId) &&
    typeof intent.manifestDigest === "string" && /^[0-9a-f]{64}$/u.test(intent.manifestDigest) &&
    identity(intent.rootIdentity) && identity(intent.metadataIdentity) &&
    Array.isArray(intent.nodes) && isHermesSourceSnapshotGcNodeInventoryWithinLimits(intent.nodes) && intent.nodes.every(isSnapshotGcNode) &&
    (intent.projectionIdentity === null || identity(intent.projectionIdentity)) &&
    typeof intent.metadataSha256 === "string" && /^[0-9a-f]{64}$/u.test(intent.metadataSha256) &&
    (intent.projectionSha256 === null || (typeof intent.projectionSha256 === "string" && /^[0-9a-f]{64}$/u.test(intent.projectionSha256)));
}

function isSnapshotGcNode(value: unknown): value is SnapshotGcNode {
  if (value === null || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  const identity = node.identity as Record<string, unknown> | null;
  if (typeof node.path !== "string" || !isHermesSourceSnapshotRelativePathValid(node.path)) return false;
  if (!identity || typeof identity !== "object" || typeof identity.dev !== "string" || !/^(?:0|[1-9]\d{0,23})$/u.test(identity.dev) ||
      typeof identity.ino !== "string" || !/^(?:0|[1-9]\d{0,23})$/u.test(identity.ino)) return false;
  if (node.kind === "directory") {
    return node.mode === null && node.sha256 === null &&
      (process.platform === "win32" ? (node.modeBits === 0o444 || node.modeBits === 0o555) :
        (node.modeBits === 0o500 || node.modeBits === 0o555));
  }
  return node.kind === "file" && (node.mode === "100644" || node.mode === "100755") &&
    typeof node.sha256 === "string" && /^[0-9a-f]{64}$/u.test(node.sha256) &&
    (node.modeBits === 0o400 || node.modeBits === 0o444 || node.modeBits === 0o500 || node.modeBits === 0o555) &&
    (node.modeBits === (node.mode === "100755" ? (process.platform === "win32" ? 0o444 : 0o500) : (process.platform === "win32" ? 0o444 : 0o400)) ||
      (process.platform === "win32" && node.mode === "100755" && node.modeBits === 0o555));
}

async function collectSnapshotGcNodes(rootPath: string, manifest: SnapshotManifest): Promise<SnapshotGcNode[]> {
  const expected = expectedSnapshotGcNodes(manifest);
  const actual: SnapshotGcNode[] = [];
  await enumerateSnapshotGcTree(rootPath, "", expected, actual, false);
  if (actual.length !== expected.size) throw snapshotError();
  return actual.sort((left, right) => compareUtf8(left.path, right.path));
}

async function verifySnapshotGcSurvivors(rootPath: string, nodes: readonly SnapshotGcNode[]): Promise<void> {
  const expected = new Map(nodes.map((node) => [node.path, node]));
  const actual: SnapshotGcNode[] = [];
  await enumerateSnapshotGcTree(rootPath, "", expected, actual, true);
}

async function enumerateSnapshotGcTree(
  absolute: string,
  relative: string,
  expected: ReadonlyMap<string, SnapshotGcNode>,
  actual: SnapshotGcNode[],
  allowMissing: boolean,
): Promise<void> {
  const present = new Set<string>();
  for (const name of await readdir(absolute)) {
    const path = relative ? `${relative}/${name}` : name;
    const expectedNode = expected.get(path);
    if (!expectedNode || present.has(path)) throw snapshotError();
    present.add(path);
    const child = join(absolute, name);
    const details = await lstat(child, { bigint: true });
    const kind = details.isDirectory() ? "directory" : details.isFile() ? "file" : undefined;
    const identity = exactIdentityFromStats(details);
    if (details.isSymbolicLink() || kind !== expectedNode.kind ||
        (expectedNode.identity.dev.length > 0 && !sameExactFileIdentity(expectedNode.identity, identity))) throw snapshotError();
    const modeBits = Number(details.mode & 0o777n);
    if (kind === "directory") {
      const legacyWindowsReadonly = process.platform === "win32" && expectedNode.modeBits === 0o555 && modeBits === 0o444;
      if (modeBits !== expectedNode.modeBits && !(allowMissing && modeBits === 0o700) && !legacyWindowsReadonly) throw snapshotError();
      actual.push({ ...expectedNode, identity, modeBits });
      await enumerateSnapshotGcTree(child, path, expected, actual, allowMissing);
      continue;
    }
    const legacyWindowsReadonly = process.platform === "win32" && expectedNode.modeBits === 0o555 && modeBits === 0o444;
    if ((modeBits !== expectedNode.modeBits && !legacyWindowsReadonly) || !expectedNode.sha256) throw snapshotError();
    const bytes = await readStableFile(child, identity, MAX_FILE_BYTES);
    if (sha256(bytes) !== expectedNode.sha256) throw snapshotError();
    actual.push({ ...expectedNode, identity });
  }
  if (!allowMissing && present.size === 0 && relative.length > 0 && !expected.has(relative)) throw snapshotError();
}

function expectedSnapshotGcNodes(manifest: SnapshotManifest): Map<string, SnapshotGcNode> {
  const nodes = new Map<string, SnapshotGcNode>();
  const directories = new Set<string>();
  for (const entry of manifest.files) {
    const segments = entry.path.split("/");
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) directories.add(segments.slice(0, index).join("/"));
    nodes.set(entry.path, {
      identity: { dev: "", ino: "" }, kind: "file", mode: entry.mode,
      modeBits: entry.mode === "100755" ? (process.platform === "win32" ? 0o444 : 0o500) :
        (process.platform === "win32" ? 0o444 : 0o400), path: entry.path, sha256: entry.sha256,
    });
  }
  for (const path of directories) nodes.set(path, {
    identity: { dev: "", ino: "" }, kind: "directory", mode: null,
    modeBits: process.platform === "win32" ? 0o444 : 0o500, path, sha256: null,
  });
  return nodes;
}

function assertGcNodesMatchManifest(nodes: readonly SnapshotGcNode[], manifest: SnapshotManifest): void {
  const expected = expectedSnapshotGcNodes(manifest);
  if (nodes.length !== expected.size) throw snapshotError();
  for (const node of nodes) {
    const manifestNode = expected.get(node.path);
    if (!manifestNode || node.kind !== manifestNode.kind || node.mode !== manifestNode.mode ||
        node.sha256 !== manifestNode.sha256 || (node.modeBits !== manifestNode.modeBits &&
          !(process.platform === "win32" && node.modeBits === 0o555 && manifestNode.modeBits === 0o444 &&
            (node.kind === "directory" || node.mode === "100755")))) throw snapshotError();
    expected.delete(node.path);
  }
  if (expected.size !== 0) throw snapshotError();
}

function snapshotGcIntentPath(cacheRoot: string, directoryId: string): string {
  return join(cacheRoot, `.gc-${directoryId}.intent.json`);
}

async function removeGcTemporaryFile(path: string, expected: ExactFileIdentity): Promise<void> {
  const details = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!details) return;
  if (!details.isFile() || details.isSymbolicLink() || !sameExactFileIdentity(expected, exactIdentityFromStats(details))) throw snapshotError();
  await unlink(path);
}

async function assertNoUnresolvedStaging(cacheRoot: string): Promise<void> {
  for (const name of await readdir(cacheRoot)) {
    if (name.startsWith(".staging-")) throw snapshotError();
  }
}

async function assertAvailableSpace(cacheRoot: string, sourceBytes: number): Promise<void> {
  const filesystem = await statfs(cacheRoot);
  const available = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
  const reserve = BigInt(Math.max(MIN_DISK_RESERVE_BYTES, Math.ceil(sourceBytes * DISK_RESERVE_RATIO)));
  if (available < BigInt(sourceBytes) + reserve) throw snapshotError();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function recoverStagingArtifacts(cacheRoot: string): Promise<void> {
  const names = (await readdir(cacheRoot)).filter((name) => name.startsWith(".staging-"));
  if (names.length > 128) throw snapshotError();
  const rootPattern = /^\.staging-([0-9a-f]{64})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
  const sidecarPattern = /^(\.staging-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.owner$/u;
  const helperPath = process.platform === "win32"
    ? fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/ebb-hermes-profile-path.exe", import.meta.url))
    : undefined;
  for (const name of names) {
    const rootMatch = rootPattern.exec(name);
    const sidecarMatch = sidecarPattern.exec(name);
    if (!rootMatch && !sidecarMatch) continue;
    const stagingName = rootMatch ? name : sidecarMatch![1]!;
    const stageMatch = rootPattern.exec(stagingName);
    if (!stageMatch) continue;
    const [, directoryId, nonce] = stageMatch;
    const absolute = join(cacheRoot, stagingName);
    const ownerPath = absolute + ".owner";
    const ownerDetails = await lstat(ownerPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const details = await lstat(absolute, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!ownerDetails) {
      if (!details || !rootMatch || process.platform !== "win32") continue;
      if (!details.isDirectory() || details.isSymbolicLink()) continue;
      const identity = exactIdentityFromStats(details);
      await runVerifiedNativeHelper(helperPath!, "hermesProfilePath", [
        "source-staging-recover", cacheRoot, stagingName, identity.dev, identity.ino,
      ], { env: {}, maxBuffer: 64, timeout: 5_000 });
      if (await pathExists(absolute)) throw snapshotError();
      continue;
    }
    const owner = await readValidatedStagingOwner(ownerPath, ownerDetails);
    if (!owner || owner.directoryId !== directoryId || owner.nonce !== nonce || processIsAlive(owner.pid)) continue;
    if (details) {
      if (!rootMatch || !details.isDirectory() || details.isSymbolicLink()) continue;
      const identity = process.platform === "win32" ? exactIdentityFromStats(details) : identityFromStats(details);
      if (process.platform === "win32" && (!owner.fileIdentity || !sameExactFileIdentity(owner.fileIdentity, identity as ExactFileIdentity))) continue;
      await removeOwnedStagingTree(cacheRoot, absolute, directoryId!, nonce!, identity);
      continue;
    }
    await removePublishedStagingOwner(cacheRoot, stagingName, ownerPath, owner, ownerDetails);
  }
}

async function readValidatedStagingOwner(
  ownerPath: string,
  details: Awaited<ReturnType<typeof lstat>>,
): Promise<ReturnType<typeof parseStagingOwner> | undefined> {
  if (!details.isFile() || details.isSymbolicLink()) return undefined;
  try {
    const identity = exactIdentityFromStats(details);
    const bytes = await readStableFile(ownerPath, identity, 4096);
    const text = bytes.toString("utf8");
    const value: unknown = JSON.parse(text);
    const owner = parseStagingOwner(value);
    if (!owner || canonicalJson(owner) !== text) return undefined;
    const current = await lstat(ownerPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameExactFileIdentity(identity, exactIdentityFromStats(current))) return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

async function removePublishedStagingOwner(
  cacheRoot: string,
  stagingName: string,
  ownerPath: string,
  owner: NonNullable<ReturnType<typeof parseStagingOwner>>,
  originalOwnerDetails: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(owner.directoryId)) throw snapshotError();
  const finalPath = join(cacheRoot, owner.directoryId);
  const finalDetails = await lstat(finalPath, { bigint: true });
  if (!finalDetails.isDirectory() || finalDetails.isSymbolicLink()) throw snapshotError();
  const finalIdentity = exactIdentityFromStats(finalDetails);
  if (owner.fileIdentity && !sameExactFileIdentity(owner.fileIdentity, finalIdentity)) throw snapshotError();
  const metadataPath = metadataPathFor(cacheRoot, owner.directoryId);
  const metadataBytes = await readStableFile(metadataPath, undefined, MAX_MANIFEST_BYTES);
  const metadataText = metadataBytes.toString("utf8");
  const parsedMetadata = JSON.parse(metadataText) as SnapshotMetadata;
  if (canonicalJson(parsedMetadata) !== metadataText || typeof parsedMetadata.cacheKey !== "string") throw snapshotError();
  const parsed = validateMetadataAndKey(parsedMetadata, parsedMetadata.cacheKey);
  if (parsed.directoryId !== owner.directoryId ||
      (process.platform === "win32" && owner.fileIdentity && parsed.identity.materializationPolicyVersion !== 2) ||
      stagingName !== `.staging-${owner.directoryId}-${owner.nonce}`) throw snapshotError();
  await verifySnapshotTree(finalPath, parsed.manifest);
  await assertSnapshotRootIdentity(finalPath, owner.fileIdentity ?? finalIdentity);
  const ownerIdentity = exactIdentityFromStats(originalOwnerDetails);
  const bytes = await readStableFile(ownerPath, ownerIdentity, 4096);
  const ownerText = bytes.toString("utf8");
  if (canonicalJson(JSON.parse(ownerText)) !== ownerText || canonicalJson(JSON.parse(ownerText)) !== canonicalJson(owner)) throw snapshotError();
  const currentRoot = await lstat(finalPath, { bigint: true });
  const currentOwner = await lstat(ownerPath, { bigint: true });
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() ||
      !sameExactFileIdentity(finalIdentity, exactIdentityFromStats(currentRoot)) ||
      !currentOwner.isFile() || currentOwner.isSymbolicLink() ||
      !sameExactFileIdentity(ownerIdentity, exactIdentityFromStats(currentOwner))) throw snapshotError();
  await unlink(ownerPath);
  await syncDirectory(cacheRoot);
}

function parseStagingOwner(value: unknown): {
  directoryId: string; nonce: string; pid: number; startedAt: number; fileIdentity?: ExactFileIdentity;
} | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fileIdentity = record.fileIdentity;
  const identityRecord = typeof fileIdentity === "object" && fileIdentity !== null ? fileIdentity as Record<string, unknown> : undefined;
  const dev = identityRecord?.dev;
  const ino = identityRecord?.ino;
  const hasIdentity = typeof dev === "string" && /^(?:0|[1-9]\d{0,23})$/u.test(dev) &&
    typeof ino === "string" && /^(?:0|[1-9]\d{0,23})$/u.test(ino) && Object.keys(identityRecord ?? {}).sort().join(",") === "dev,ino";
  const expectedKeys = hasIdentity ? "directoryId,fileIdentity,nonce,pid,startedAt" : "directoryId,nonce,pid,startedAt";
  if (Object.keys(record).sort().join(",") !== expectedKeys ||
      !hasIdentity && fileIdentity !== undefined || typeof record.directoryId !== "string" || !/^[0-9a-f]{64}$/u.test(record.directoryId) ||
      typeof record.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.nonce) ||
      typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0 ||
      typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return undefined;
  return {
    directoryId: record.directoryId,
    nonce: record.nonce,
    pid: record.pid,
    startedAt: record.startedAt,
    ...(hasIdentity ? { fileIdentity: { dev: dev as string, ino: ino as string } } : {}),
  };
}

async function createSnapshotStagingDirectory(
  cacheRoot: string, stageRoot: string,
): Promise<FileIdentity | ExactFileIdentity> {
  if (process.platform !== "win32") {
    await mkdir(stageRoot, { mode: 0o700 });
    return identityFromStats(await lstat(stageRoot));
  }
  const helperPath = fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/ebb-hermes-profile-path.exe", import.meta.url));
  const result = await runVerifiedNativeHelper(helperPath, "hermesProfilePath", [
    "source-staging-create", cacheRoot, basename(stageRoot),
  ], { env: {}, maxBuffer: 256, timeout: 5_000 });
  const nativeIdentity = parseNativeFileIdentity(result.stdout);
  const handle = await open(stageRoot, fsConstants.O_RDONLY);
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(stageRoot, { bigint: true });
    if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
        !sameExactFileIdentity(nativeIdentity, exactIdentityFromStats(opened)) ||
        !sameExactFileIdentity(nativeIdentity, exactIdentityFromStats(named))) throw snapshotError();
  } finally {
    await handle.close();
  }
  return nativeIdentity;
}

async function assertStagingIdentity(stageRoot: string, expected: FileIdentity | ExactFileIdentity): Promise<void> {
  const handle = await open(stageRoot, fsConstants.O_RDONLY);
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(stageRoot, { bigint: true });
    const openedIdentity = typeof expected.dev === "string" ? exactIdentityFromStats(opened) : identityFromStats(opened);
    const namedIdentity = typeof expected.dev === "string" ? exactIdentityFromStats(named) : identityFromStats(named);
    if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
        !sameStableFileIdentity(expected, openedIdentity) || !sameStableFileIdentity(expected, namedIdentity)) throw snapshotError();
  } finally {
    await handle.close();
  }
}

async function assertSnapshotRootIdentity(path: string, expected: FileIdentity | ExactFileIdentity): Promise<void> {
  await assertStagingIdentity(path, expected);
}

async function writeStagingOwner(
  stageRoot: string, directoryId: string, nonce: string, identity: FileIdentity | ExactFileIdentity,
): Promise<void> {
  const handle = await open(stageRoot + ".owner", "wx", 0o600);
  try {
    const fileIdentity = typeof identity.dev === "string" ? identity : undefined;
    await handle.writeFile(canonicalJson({ directoryId, nonce, pid: process.pid, startedAt: Date.now(), ...(fileIdentity ? { fileIdentity } : {}) }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeStagingOwner(
  stageRoot: string, expectedRootIdentity?: FileIdentity | ExactFileIdentity, liveRootPath = stageRoot,
): Promise<void> {
  if (expectedRootIdentity) await assertSnapshotRootIdentity(liveRootPath, expectedRootIdentity);
  const path = stageRoot + ".owner";
  const details = await lstat(path, { bigint: process.platform === "win32" });
  if (!details.isFile() || details.isSymbolicLink()) throw snapshotError();
  await unlink(path);
}

async function removeOwnedStagingTree(
  cacheRoot: string,
  stagePath: string,
  directoryId: string,
  nonce: string,
  expectedIdentity: FileIdentity | ExactFileIdentity,
): Promise<void> {
  if (dirname(stagePath) !== cacheRoot || basename(stagePath) !== ".staging-" + directoryId + "-" + nonce) throw snapshotError();
  const root = await lstat(stagePath, { bigint: typeof expectedIdentity.dev === "string" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink() || !sameStableFileIdentity(expectedIdentity, typeof expectedIdentity.dev === "string" ? exactIdentityFromStats(root) : identityFromStats(root))) throw snapshotError();
  if (typeof expectedIdentity.dev === "string") await assertStagingIdentity(stagePath, expectedIdentity);
  await chmod(stagePath, 0o700);
  await removeChildrenNoFollow(stagePath);
  const current = await lstat(stagePath, { bigint: typeof expectedIdentity.dev === "string" });
  if (!current.isDirectory() || current.isSymbolicLink() || !sameStableFileIdentity(expectedIdentity, typeof expectedIdentity.dev === "string" ? exactIdentityFromStats(current) : identityFromStats(current))) throw snapshotError();
  if (typeof expectedIdentity.dev === "string") await assertStagingIdentity(stagePath, expectedIdentity);
  await rmdir(stagePath);
  if (await pathExists(stagePath + ".owner")) await removeStagingOwner(stagePath);
}

async function removeChildrenNoFollow(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const child = join(directory, name);
    const details = await lstat(child);
    if (details.isSymbolicLink()) throw snapshotError();
    if (details.isDirectory()) {
      await chmod(child, 0o700);
      await removeChildrenNoFollow(child);
      await rmdir(child);
      await syncDirectory(directory);
    } else if (details.isFile()) {
      await unlink(child);
    } else {
      throw snapshotError();
    }
  }
  await syncDirectory(directory);
}

async function persistSnapshotMetadata(
  cacheRoot: string,
  metadataPath: string,
  directoryId: string,
  metadata: SnapshotMetadata,
): Promise<void> {
  const bytes = Buffer.from(canonicalJson(metadata), "utf8");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw snapshotError();
  await recoverOwnedMetadataAliases(cacheRoot, directoryId);
  const existing = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    const current = await readStableFile(metadataPath, identityFromStats(existing), MAX_MANIFEST_BYTES);
    if (!current.equals(bytes)) throw snapshotError();
    return;
  }
  const nonce = randomUUID();
  const temporaryPath = join(cacheRoot, ".metadata-" + directoryId + "-" + nonce);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const fileIdentity = identityFromStats(await lstat(temporaryPath));
  const owner = await open(temporaryPath + ".owner", "wx", 0o600);
  try {
    await owner.writeFile(canonicalJson({ directoryId, nonce, fileIdentity, formatVersion: 1 }), "utf8");
    await owner.sync();
  } finally {
    await owner.close();
  }
  await syncDirectory(cacheRoot);
  try {
    // Hard link atomically creates the metadata path without replacing an existing entry.
    await link(temporaryPath, metadataPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = await readStableFile(metadataPath, undefined, MAX_MANIFEST_BYTES);
    if (!current.equals(bytes)) throw snapshotError();
  } finally {
    await unlink(temporaryPath);
    await unlink(temporaryPath + ".owner");
  }
  const published = await readStableFile(metadataPath, undefined, MAX_MANIFEST_BYTES);
  if (!published.equals(bytes)) throw snapshotError();
  await syncDirectory(cacheRoot);
}

async function ensureNativeProjection(
  cacheRoot: string,
  snapshot: HermesSourceSnapshot,
  manifest: SnapshotManifest,
): Promise<HermesSourceSnapshotNativeProjection> {
  markHermesSourceSnapshotDiagnosticPhase("native-projection-final-verify");
  const bytes = encodeNativeProjection(snapshot, manifest);
  const digest = sha256(bytes);
  const finalPath = nativeProjectionPathFor(cacheRoot, snapshot.directoryId);
  markHermesSourceSnapshotDiagnosticPhase("native-projection-alias-cleanup");
  await recoverNativeProjectionAliases(cacheRoot, snapshot.directoryId);
  markHermesSourceSnapshotDiagnosticPhase("native-projection-final-verify");
  const existing = await lstat(finalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size !== bytes.byteLength) throw snapshotError();
    const actual = await readStableFile(finalPath, identityFromStats(existing), MAX_NATIVE_PROJECTION_BYTES);
    if (!actual.equals(bytes)) throw snapshotError();
    return Object.freeze({ path: finalPath, sha256: digest, size: bytes.byteLength });
  }

  const nonce = randomUUID();
  const temporaryPath = join(cacheRoot, `.projection-${snapshot.directoryId}-${nonce}`);
  const ownerPath = temporaryPath + ".owner";
  let temporaryCreated = false;
  let ownerCreated = false;
  try {
    let nativeIdentity: ExactFileIdentity | undefined;
    if (process.platform === "win32") {
      markHermesSourceSnapshotDiagnosticPhase("native-projection-helper-create");
      const helperPath = fileURLToPath(new URL("../../../../dist/native/hermes-profile-path/ebb-hermes-profile-path.exe", import.meta.url));
      const result = await runVerifiedNativeHelper(helperPath, "hermesProfilePath", [
        "source-projection-create", cacheRoot, basename(temporaryPath),
      ], { env: {}, maxBuffer: 256, timeout: 5_000 });
      temporaryCreated = true;
      nativeIdentity = parseNativeFileIdentity(result.stdout);
    }
    markHermesSourceSnapshotDiagnosticPhase("native-projection-open-verify-temp");
    const handle = await open(temporaryPath, process.platform === "win32" ? "r+" : "wx", 0o600);
    temporaryCreated = true;
    try {
      if (nativeIdentity) {
        const openedIdentity = exactIdentityFromStats(await handle.stat({ bigint: true }));
        const named = await lstat(temporaryPath, { bigint: true });
        if (!named.isFile() || named.isSymbolicLink() || !sameExactFileIdentity(nativeIdentity, openedIdentity) ||
            !sameExactFileIdentity(nativeIdentity, exactIdentityFromStats(named))) throw snapshotError();
      }
      markHermesSourceSnapshotDiagnosticPhase("native-projection-write-seal");
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const temporaryDetails = await lstat(temporaryPath, { bigint: true });
    const identity = exactIdentityFromStats(temporaryDetails);
    if (!temporaryDetails.isFile() || temporaryDetails.isSymbolicLink() ||
        (nativeIdentity && !sameExactFileIdentity(nativeIdentity, identity))) throw snapshotError();
    markHermesSourceSnapshotDiagnosticPhase("native-projection-owner-publish-link");
    const owner = await open(ownerPath, "wx", 0o600);
    ownerCreated = true;
    try {
      await owner.writeFile(canonicalJson({ directoryId: snapshot.directoryId, nonce, fileIdentity: identity, formatVersion: 1, pid: process.pid }));
      await owner.sync();
    } finally {
      await owner.close();
    }
    await syncDirectory(cacheRoot);
    try {
      markHermesSourceSnapshotDiagnosticPhase("native-projection-owner-publish-link");
      await link(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await lstat(finalPath);
      if (!raced.isFile() || raced.isSymbolicLink() || raced.size !== bytes.byteLength ||
          !(await readStableFile(finalPath, identityFromStats(raced), MAX_NATIVE_PROJECTION_BYTES)).equals(bytes)) throw snapshotError();
    }
    // Keep the identity-owner until alias cleanup succeeds. A crash or EIO is recoverable only
    // when the owner proves that both names are the exact file created for this key.
    markHermesSourceSnapshotDiagnosticPhase("native-projection-alias-cleanup");
    await unlink(temporaryPath);
    temporaryCreated = false;
    await unlink(ownerPath);
    ownerCreated = false;
    await syncDirectory(cacheRoot);
  } catch (error) {
    // An owned alias is intentionally left for identity-checked recovery. Unowned partials are
    // not silently removed because a path race would make cleanup unsafe.
    if (temporaryCreated && !ownerCreated) throw snapshotError();
    throw error;
  }

  markHermesSourceSnapshotDiagnosticPhase("native-projection-final-verify");
  const final = await lstat(finalPath);
  if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1 || final.size !== bytes.byteLength) throw snapshotError();
  const verified = await readStableFile(finalPath, identityFromStats(final), MAX_NATIVE_PROJECTION_BYTES);
  if (!verified.equals(bytes) || sha256(verified) !== digest) throw snapshotError();
  return Object.freeze({ path: finalPath, sha256: digest, size: bytes.byteLength });
}

function parseNativeFileIdentity(output: string): ExactFileIdentity {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw snapshotError();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "dev,ino" ||
        typeof record.dev !== "string" || !/^(?:0|[1-9]\d{0,23})$/u.test(record.dev) ||
        typeof record.ino !== "string" || !/^(?:0|[1-9]\d{0,23})$/u.test(record.ino)) throw snapshotError();
    return { dev: record.dev, ino: record.ino };
  } catch {
    throw snapshotError();
  }
}

function encodeNativeProjection(snapshot: HermesSourceSnapshot, manifest: SnapshotManifest): Buffer {
  const key = Buffer.from(snapshot.cacheKey, "utf8");
  if (key.byteLength > MAX_MANIFEST_BYTES || manifest.files.length > MAX_FILE_COUNT) throw snapshotError();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(76);
  header.write("EHSP", 0, 4, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(key.byteLength, 8);
  Buffer.from(snapshot.directoryId, "hex").copy(header, 12);
  Buffer.from(snapshot.manifestDigest, "hex").copy(header, 44);
  parts.push(header, key);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(manifest.files.length, 0);
  parts.push(count);
  let size = header.byteLength + key.byteLength + count.byteLength;
  for (const entry of manifest.files) {
    const name = Buffer.from(entry.path, "utf8");
    if (name.byteLength === 0 || name.byteLength > 0xffff) throw snapshotError();
    const prefix = Buffer.alloc(3);
    prefix.writeUInt16LE(name.byteLength, 0);
    prefix.writeUInt8(entry.mode === "100644" ? 0 : 1, 2);
    const hash = Buffer.from(entry.sha256, "hex");
    size += prefix.byteLength + name.byteLength + hash.byteLength;
    if (size > MAX_NATIVE_PROJECTION_BYTES) throw snapshotError();
    parts.push(prefix, name, hash);
  }
  return Buffer.concat(parts, size);
}

async function recoverNativeProjectionAliases(cacheRoot: string, directoryId: string): Promise<void> {
  const targetPath = nativeProjectionPathFor(cacheRoot, directoryId);
  const ownerPrefix = `.projection-${directoryId}-`;
  const names = await readdir(cacheRoot);
  const owners = new Set(names.filter((name) => name.startsWith(ownerPrefix) && name.endsWith(".owner")));
  for (const name of names) {
    if (name.startsWith(ownerPrefix) && !name.endsWith(".owner") && !owners.has(name + ".owner")) throw snapshotError();
  }
  for (const ownerName of owners) {
    const nonce = ownerName.slice(ownerPrefix.length, -".owner".length);
    if (!/^[0-9a-f-]{36}$/u.test(nonce)) throw snapshotError();
    const ownerPath = join(cacheRoot, ownerName);
    const ownerValue: unknown = JSON.parse((await readStableFile(ownerPath, undefined, 4096)).toString("utf8"));
    if (!ownerValue || typeof ownerValue !== "object") throw snapshotError();
    const owner = ownerValue as Record<string, unknown>;
    if (owner.formatVersion !== 1 || owner.directoryId !== directoryId || owner.nonce !== nonce ||
        typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
        !owner.fileIdentity || typeof owner.fileIdentity !== "object") throw snapshotError();
    if (owner.pid !== process.pid && processIsAlive(owner.pid)) throw snapshotError();
    const expected = owner.fileIdentity as Partial<FileIdentity> & Partial<ExactFileIdentity>;
    const exactIdentity = typeof expected.dev === "string" && /^(?:0|[1-9]\d{0,23})$/u.test(expected.dev) &&
      typeof expected.ino === "string" && /^(?:0|[1-9]\d{0,23})$/u.test(expected.ino)
      ? { dev: expected.dev, ino: expected.ino } satisfies ExactFileIdentity
      : undefined;
    const legacyIdentity = typeof expected.dev === "number" && Number.isSafeInteger(expected.dev) && expected.dev >= 0 &&
      typeof expected.ino === "number" && Number.isSafeInteger(expected.ino) && expected.ino >= 0
      ? { dev: expected.dev, ino: expected.ino } satisfies FileIdentity
      : undefined;
    if (!exactIdentity && !legacyIdentity) throw snapshotError();
    const temporaryPath = ownerPath.slice(0, -".owner".length);
    const target = await lstat(targetPath, exactIdentity ? { bigint: true } : undefined).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const temporary = await lstat(temporaryPath, exactIdentity ? { bigint: true } : undefined).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const matchesOwnerIdentity = (details: Awaited<ReturnType<typeof lstat>> | undefined): boolean => {
      if (!details) return true;
      if (exactIdentity) return sameExactFileIdentity(exactIdentity, exactIdentityFromStats(details));
      return legacyIdentity !== undefined && sameFileIdentity(identityFromStats(details), legacyIdentity);
    };
    if (target && (!target.isFile() || target.isSymbolicLink() || !matchesOwnerIdentity(target))) throw snapshotError();
    if (temporary && (!temporary.isFile() || temporary.isSymbolicLink() || !matchesOwnerIdentity(temporary))) throw snapshotError();
    if (target) {
      if (temporary) await unlink(temporaryPath);
    } else if (temporary) {
      await unlink(temporaryPath);
    }
    await unlink(ownerPath);
    await syncDirectory(cacheRoot);
  }
}

async function recoverOwnedMetadataAliases(cacheRoot: string, directoryId: string): Promise<void> {
  const metadataPath = metadataPathFor(cacheRoot, directoryId);
  const metadata = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw snapshotError();
  const expected = identityFromStats(metadata);
  const prefix = ".metadata-" + directoryId + "-";
  for (const name of await readdir(cacheRoot)) {
    if (!name.startsWith(prefix) || !name.endsWith(".owner")) continue;
    const nonce = name.slice(prefix.length, -6);
    if (!/^[0-9a-f-]{36}$/u.test(nonce)) continue;
    const ownerPath = join(cacheRoot, name);
    const owner: unknown = JSON.parse((await readStableFile(ownerPath, undefined, 4096)).toString("utf8"));
    if (!owner || typeof owner !== "object") throw snapshotError();
    const record = owner as Record<string, unknown>;
    if (record.formatVersion !== 1 || record.directoryId !== directoryId || record.nonce !== nonce ||
        !record.fileIdentity || typeof record.fileIdentity !== "object") throw snapshotError();
    const recordedIdentity = record.fileIdentity as Partial<FileIdentity>;
    if (recordedIdentity.dev !== expected.dev || recordedIdentity.ino !== expected.ino) throw snapshotError();
    const aliasPath = ownerPath.slice(0, -6);
    const alias = await lstat(aliasPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (alias) {
      if (!alias.isFile() || alias.isSymbolicLink() || !sameFileIdentity(expected, identityFromStats(alias))) throw snapshotError();
      await unlink(aliasPath);
    }
    await unlink(ownerPath);
  }
  await syncDirectory(cacheRoot);
}

async function readSnapshotMetadata(cacheRoot: string, cacheKey: string): Promise<SnapshotMetadata> {
  await recoverOwnedMetadataAliases(cacheRoot, sha256(cacheKey));
  const bytes = await readStableFile(metadataPathFor(cacheRoot, sha256(cacheKey)), undefined, MAX_MANIFEST_BYTES);
  const text = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw snapshotError();
  }
  if (canonicalJson(parsed) !== text) throw snapshotError();
  return parsed as SnapshotMetadata;
}

function validateMetadataAndKey(metadata: SnapshotMetadata, requestedKey: string): {
  readonly directoryId: string;
  readonly identity: SnapshotIdentity;
  readonly manifest: SnapshotManifest;
} {
  if (!metadata || typeof metadata !== "object" || typeof metadata.cacheKey !== "string" || metadata.cacheKey !== requestedKey ||
      !metadata.identity || !metadata.manifest) throw snapshotError();
  const identity = metadata.identity as SnapshotIdentity;
  const identityKeys = Object.keys(identity).sort(compareUtf8).join(",");
  const hasWindowsMaterializationPolicy = identity.materializationPolicyVersion === 2;
  if ((hasWindowsMaterializationPolicy && identityKeys !== "formatVersion,hermesVersion,manifestDigest,materializationPolicyVersion,sourceCommit,sourceTree") ||
      (!hasWindowsMaterializationPolicy && identityKeys !== "formatVersion,hermesVersion,manifestDigest,sourceCommit,sourceTree")) throw snapshotError();
  if (identity.formatVersion !== IDENTITY_FORMAT_VERSION || typeof identity.hermesVersion !== "string" ||
      identity.hermesVersion.length === 0 || identity.hermesVersion.length > 256 ||
      hasControlCharacter(identity.hermesVersion) || !identity.hermesVersion.isWellFormed() ||
      !isGitObjectId(identity.sourceCommit) || !isGitObjectId(identity.sourceTree) ||
      identity.sourceCommit.length !== identity.sourceTree.length || !isGitObjectId(identity.manifestDigest) ||
      identity.manifestDigest.length !== 64) throw snapshotError();
  const manifest = validateManifest(metadata.manifest);
  if (sha256(canonicalJson(manifest)) !== identity.manifestDigest || canonicalJson(identity) !== requestedKey ||
      canonicalJson(metadata) !== canonicalJson({ cacheKey: requestedKey, identity, manifest })) throw snapshotError();
  return { directoryId: sha256(requestedKey), identity, manifest };
}

function validateManifest(value: SnapshotManifest): SnapshotManifest {
  if (!value || typeof value !== "object" || value.formatVersion !== MANIFEST_FORMAT_VERSION || !Array.isArray(value.files) ||
      value.files.length === 0 || value.files.length > MAX_FILE_COUNT) throw snapshotError();
  const files: ManifestEntry[] = [];
  const exact = new Set<string>();
  const folded = new Set<string>();
  let previous: string | undefined;
  let totalPathBytes = 0;
  for (const item of value.files as readonly ManifestEntry[]) {
    if (!item || typeof item !== "object" || (item.mode !== "100644" && item.mode !== "100755") ||
        typeof item.path !== "string" || !isGitObjectId(item.sha256) || item.sha256.length !== 64) throw snapshotError();
    validateRelativePath(item.path);
    const foldedPath = item.path.normalize("NFC").toLowerCase();
    if (exact.has(item.path) || folded.has(foldedPath) || (previous !== undefined && compareUtf8(previous, item.path) >= 0)) {
      throw snapshotError();
    }
    exact.add(item.path);
    folded.add(foldedPath);
    previous = item.path;
    totalPathBytes += Buffer.byteLength(item.path, "utf8");
    files.push({ mode: item.mode, path: item.path, sha256: item.sha256 });
  }
  if (totalPathBytes > MAX_TOTAL_BYTES) throw snapshotError();
  return { files, formatVersion: MANIFEST_FORMAT_VERSION };
}

async function lookupExpectedSnapshot(
  cacheRoot: string,
  cacheKey: string,
  metadataPath: string,
  finalPath: string,
  expectedIdentity: SnapshotIdentity,
  expectedManifest: SnapshotManifest,
): Promise<HermesSourceSnapshot> {
  await recoverOwnedMetadataAliases(cacheRoot, sha256(cacheKey));
  const text = (await readStableFile(metadataPath, undefined, MAX_MANIFEST_BYTES)).toString("utf8");
  const metadata = JSON.parse(text) as SnapshotMetadata;
  if (canonicalJson(metadata) !== text) throw snapshotError();
  const parsed = validateMetadataAndKey(metadata, cacheKey);
  if (canonicalJson(parsed.identity) !== canonicalJson(expectedIdentity) || !sameManifest(parsed.manifest, expectedManifest)) {
    throw snapshotError();
  }
  const result = snapshotResult(cacheRoot, cacheKey, parsed.directoryId, parsed.identity.manifestDigest);
  if (result.rootPath !== finalPath) throw snapshotError();
  await verifySnapshotTree(finalPath, parsed.manifest);
  return result;
}

async function verifySnapshotTree(rootPath: string, manifestValue: SnapshotManifest): Promise<void> {
  const manifest = validateManifest(manifestValue);
  const rootDetails = await lstat(rootPath);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() ||
      (process.platform !== "win32" && (rootDetails.mode & 0o777) !== 0o500)) throw snapshotError();
  const rootIdentity = identityFromStats(rootDetails);
  const expectedFiles = new Map(manifest.files.map((entry) => [entry.path, entry] as const));
  const expectedDirectories = new Set<string>();
  for (const entry of manifest.files) {
    const pieces = entry.path.split("/");
    pieces.pop();
    for (let index = 1; index <= pieces.length; index += 1) expectedDirectories.add(pieces.slice(0, index).join("/"));
  }
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const seenFolded = new Set<string>();
  let total = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      if (!name || name.includes("/") || name.includes("\\") || hasControlCharacter(name)) throw snapshotError();
      const path = prefix ? prefix + "/" + name : name;
      validateRelativePath(path);
      const folded = path.normalize("NFC").toLowerCase();
      if (seenFolded.has(folded)) throw snapshotError();
      seenFolded.add(folded);
      const absolute = join(directory, name);
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) throw snapshotError();
      if (before.isDirectory()) {
        if (!expectedDirectories.has(path) || seenDirectories.has(path)) throw snapshotError();
        seenDirectories.add(path);
        if (process.platform !== "win32" && (before.mode & 0o777) !== 0o500) throw snapshotError();
        await walk(absolute, path);
      } else if (before.isFile()) {
        const entry = expectedFiles.get(path);
        if (!entry || seenFiles.has(path)) throw snapshotError();
        if (process.platform !== "win32") {
          const expectedMode = entry.mode === "100755" ? 0o500 : 0o400;
          if ((before.mode & 0o777) !== expectedMode) throw snapshotError();
        }
        const actual = await hashSnapshotFile(absolute, before, MAX_FILE_BYTES);
        if (actual.digest !== entry.sha256) throw snapshotError();
        total += actual.size;
        if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) throw snapshotError();
        seenFiles.add(path);
      } else {
        throw snapshotError();
      }
    }
  };
  await walk(rootPath, "");
  if (seenFiles.size !== expectedFiles.size || seenDirectories.size !== expectedDirectories.size) throw snapshotError();
  const afterRoot = await lstat(rootPath);
  if (!afterRoot.isDirectory() || afterRoot.isSymbolicLink() || !sameFileIdentity(rootIdentity, identityFromStats(afterRoot))) throw snapshotError();
}

async function hashSnapshotFile(path: string, before: Awaited<ReturnType<typeof lstat>>, maxBytes: number): Promise<{ digest: string; size: number }> {
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw snapshotError();
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(identityFromStats(before), identityFromStats(opened)) ||
        opened.size > maxBytes || opened.nlink !== 1) throw snapshotError();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let position = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > maxBytes) throw snapshotError();
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (!after.isFile() || !sameFileIdentity(identityFromStats(opened), identityFromStats(after)) || after.size !== size) throw snapshotError();
    return { digest: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

async function readStableFile(path: string, expected: FileIdentity | ExactFileIdentity | undefined, maxBytes: number): Promise<Buffer> {
  const exact = expected !== undefined && typeof expected.dev === "string";
  const before = exact ? await lstat(path, { bigint: true }) : await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || Number(before.size) > maxBytes ||
      (expected && !sameStableFileIdentity(expected, exact ? exactIdentityFromStats(before) : identityFromStats(before)))) throw snapshotError();
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = exact ? await handle.stat({ bigint: true }) : await handle.stat();
    const openedIdentity = exact ? exactIdentityFromStats(opened) : identityFromStats(opened);
    const beforeIdentity = exact ? exactIdentityFromStats(before) : identityFromStats(before);
    if (!opened.isFile() || !sameStableFileIdentity(beforeIdentity, openedIdentity) ||
        Number(opened.size) > maxBytes || Number(opened.nlink) !== 1) throw snapshotError();
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteCount = 0;
    while (true) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - byteCount), byteCount);
      if (result.bytesRead === 0) break;
      byteCount += result.bytesRead;
      if (byteCount > maxBytes) throw snapshotError();
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const bytes = Buffer.concat(chunks, byteCount);
    const after = exact ? await handle.stat({ bigint: true }) : await handle.stat();
    if (!sameStableFileIdentity(openedIdentity, exact ? exactIdentityFromStats(after) : identityFromStats(after)) ||
        Number(after.size) !== bytes.byteLength || bytes.byteLength > maxBytes) {
      throw snapshotError();
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function metadataPathFor(cacheRoot: string, directoryId: string): string {
  return join(cacheRoot, directoryId + ".manifest.json");
}
function nativeProjectionPathFor(cacheRoot: string, directoryId: string): string {
  return join(cacheRoot, directoryId + ".native-v1.bin");
}
function snapshotResult(cacheRoot: string, cacheKey: string, directoryId: string, manifestDigest: string): HermesSourceSnapshot {
  const snapshot = Object.freeze({ cacheKey, directoryId, manifestDigest, rootPath: join(cacheRoot, directoryId) });
  verifiedSnapshots.add(snapshot);
  return snapshot;
}
function totalBytes(entries: readonly SizedManifestEntry[]): number {
  return entries.reduce((total, entry) => total + entry.size, 0);
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
  }
  throw snapshotError();
}
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function depth(path: string): number {
  return path ? path.split("/").length : 0;
}
function sameHostPath(left: string, right: string): boolean {
  if (process.platform !== "win32") return resolve(left) === resolve(right);
  return resolve(left).replaceAll("/", "\\").toLowerCase() === resolve(right).replaceAll("/", "\\").toLowerCase();
}
function identityFromStats(value: { readonly dev: number | bigint; readonly ino: number | bigint }): FileIdentity {
  return { dev: Number(value.dev), ino: Number(value.ino) };
}
function exactIdentityFromStats(value: { readonly dev: number | bigint; readonly ino: number | bigint }): ExactFileIdentity {
  return { dev: String(value.dev), ino: String(value.ino) };
}
function sameExactFileIdentity(left: ExactFileIdentity, right: ExactFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameStableFileIdentity(left: FileIdentity | ExactFileIdentity, right: FileIdentity | ExactFileIdentity): boolean {
  if (typeof left.dev === "string" && typeof right.dev === "string") return left.dev === right.dev && left.ino === right.ino;
  if (typeof left.dev === "number" && typeof right.dev === "number") {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return false;
}
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function snapshotError(): HermesSourceSnapshotError {
  return new HermesSourceSnapshotError();
}

async function captureGit(git: string, cwd: string, args: string[], maxBytes: number): Promise<string> {
  return (await captureGitBytes(git, cwd, args, maxBytes)).toString("utf8");
}
async function captureGitBytes(git: string, cwd: string, args: string[], maxBytes: number): Promise<Buffer> {
  const child = spawn(git, ["-C", cwd, ...args], {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: gitEnvironment(),
  });
  const chunks: Buffer[] = [];
  let total = 0;
  const stderr = collectBounded(child.stderr, 64 * 1024);
  const output = (async () => {
    for await (const value of child.stdout) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) throw snapshotError();
      chunks.push(chunk);
    }
  })();
  const exit = observeChild(child);
  void exit.catch(() => terminateChild(child));
  void stderr.catch(() => terminateChild(child));
  try {
    await output;
    const status = await exit;
    await stderr;
    if (status.code !== 0 || status.signal !== null) throw snapshotError();
    return Buffer.concat(chunks, total);
  } catch {
    terminateChild(child);
    await exit.catch(() => undefined);
    await output.catch(() => undefined);
    await stderr.catch(() => undefined);
    throw snapshotError();
  }
}
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    PATH: process.env.PATH ?? "",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}
function collectBounded(stream: NodeJS.ReadableStream, limit: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let bytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) rejectPromise(snapshotError());
    });
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
}
function observeChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}
function terminateChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
async function writeLine(child: ChildProcessWithoutNullStreams, value: string): Promise<void> {
  if (child.stdin.destroyed || child.stdin.writableEnded) throw snapshotError();
  if (child.stdin.write(value, "ascii")) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.stdin.once("drain", resolvePromise);
    child.stdin.once("error", rejectPromise);
  });
}
class AsyncByteReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;
  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  }
  async readLine(maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      if (this.offset >= this.current.byteLength) await this.advance();
      const newline = this.current.indexOf(0x0a, this.offset);
      const end = newline < 0 ? this.current.byteLength : newline;
      const part = this.current.subarray(this.offset, end);
      if (part.byteLength > 0) chunks.push(part);
      length += part.byteLength;
      if (length > maxBytes) throw snapshotError();
      this.offset = newline < 0 ? end : newline + 1;
      if (newline >= 0) return Buffer.concat(chunks, length);
    }
  }
  async readExactly(size: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.consumeExactly(size, async (chunk) => { chunks.push(Buffer.from(chunk)); });
    return Buffer.concat(chunks, size);
  }
  async consumeExactly(size: number, consume: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.offset >= this.current.byteLength) await this.advance();
      const count = Math.min(remaining, this.current.byteLength - this.offset);
      const chunk = this.current.subarray(this.offset, this.offset + count);
      this.offset += count;
      remaining -= count;
      await consume(chunk);
    }
  }
  async assertEnd(): Promise<void> {
    if (this.offset < this.current.byteLength) throw snapshotError();
    const next = await this.iterator.next();
    if (!next.done) throw snapshotError();
    this.ended = true;
  }
  private async advance(): Promise<void> {
    if (this.ended) throw snapshotError();
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      throw snapshotError();
    }
    this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.offset = 0;
  }
}
