/**
 * Crash-safe artifact store.
 *
 * Writes artifacts through a two-phase staging protocol:
 * 1. Write content to a temp file and fsync.
 * 2. Insert a STAGING DB row.
 * 3. Rename temp → final path (atomic on same filesystem).
 * 4. Promote the DB row to ACTIVE.
 *
 * A crash between steps 2 and 4 leaves a STAGING row and possibly a
 * temp file.  `reconcileStagingArtifacts()` cleans these up on startup.
 */

import { randomUUID, createHash } from "node:crypto";
import { open, rename, unlink, access, mkdir, readFile, readdir, rmdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { ArtifactRepository } from "./artifact-repository.js";

/** Public interface returned to callers. */
export interface ArtifactRecord {
  id: string;
  type: string;
  storagePath: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  status: string;
}

/** Input for writing a new artifact. */
export interface WriteArtifactInput {
  type: string;
  contentType?: string | null;
  bytes: Buffer;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  expiresAt?: string | null;
}

/** Result of a reconciliation pass. */
export interface ReconcileResult {
  /** Number of staging rows promoted to ACTIVE. */
  promoted: number;
  /** Number of stale rows deleted. */
  cleaned: number;
}

/**
 * Internal options for testing.  The underscore-prefixed flags are only
 * used in tests to simulate failures at specific points.
 */
export interface ArtifactStoreOptions {
  _failBeforeRename?: boolean;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class ArtifactStore {
  constructor(
    private readonly artifactsDir: string,
    private readonly repository: ArtifactRepository,
    private readonly options?: ArtifactStoreOptions,
  ) {}

  /**
   * Write an artifact atomically via staging.
   */
  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Compute hash and size before any filesystem / DB work.
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const sizeBytes = input.bytes.length;

    // Derive a deterministic relative path: `<id>/<filename>`.
    // The caller specifies `type`; we use the id as a unique directory.
    const relativePath = `${id}/artifact`;

    const absoluteFinalPath = join(this.artifactsDir, relativePath);
    const parentDir = join(this.artifactsDir, id);
    const tempPath = `${absoluteFinalPath}.${randomUUID()}.tmp`;

    // Ensure the parent directory exists.
    await mkdir(parentDir, { recursive: true });

    // Phase 1: write to temp file and fsync.
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Optional: simulate a crash between temp write and DB insert.
    if (this.options?._failBeforeRename) {
      // Clean up the temp file before throwing.
      await unlink(tempPath).catch(() => {});
      throw new Error("Simulated failure before rename");
    }

    // Phase 2: insert STAGING row.
    this.repository.insert({
      id,
      type: input.type,
      relativePath,
      contentType: input.contentType ?? null,
      sizeBytes,
      sha256,
      status: "STAGING",
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
    });

    // Phase 3: rename temp → final.
    await rename(tempPath, absoluteFinalPath);

    // Phase 4: promote to ACTIVE.
    this.repository.updateStatus(id, "ACTIVE");

    return {
      id,
      type: input.type,
      storagePath: relativePath,
      contentType: input.contentType ?? null,
      sizeBytes,
      sha256,
      status: "ACTIVE",
    };
  }

  /**
   * Open an ACTIVE artifact for reading.
   */
  async openArtifact(id: string): Promise<Readable> {
    const row = this.repository.getById(id);
    if (!row || row.status !== "ACTIVE") {
      throw new Error(`Artifact not found: ${id}`);
    }

    const absolutePath = join(this.artifactsDir, row.relative_path);

    return createReadStream(absolutePath);
  }

  /**
   * Reconcile all STAGING artifacts.  Call on startup after a potential
   * crash.
   *
   * Rules:
   * - Final file exists + hash matches → ACTIVE
   * - Final file missing → delete stale DB row and leftover temp file
   * - Hash mismatch → MISSING and preserve evidence for diagnostics
   */
  async reconcileStagingArtifacts(): Promise<ReconcileResult> {
    const staging = this.repository.getByStatus("STAGING");
    let promoted = 0;
    let cleaned = 0;

    for (const row of staging) {
      const absoluteFinalPath = join(this.artifactsDir, row.relative_path);

      // Check if the final file exists.
      let fileExists = false;
      try {
        await access(absoluteFinalPath);
        fileExists = true;
      } catch {
        // fileExists remains false
      }

      if (!fileExists) {
        // File missing → delete stale DB row.
        this.repository.deleteById(row.id);

        // Clean up orphaned temp files: <id>/artifact.<uuid>.tmp
        const parentDir = join(this.artifactsDir, row.id);
        try {
          const files = await readdir(parentDir);
          for (const f of files) {
            if (f.endsWith(".tmp")) {
              await unlink(join(parentDir, f)).catch(() => {});
            }
          }
          await rmdir(parentDir).catch(() => {});
        } catch {
          // Directory may not exist; ignore.
        }

        cleaned++;
        continue;
      }

      // File exists → verify hash.
      const fileContent = await readFile(absoluteFinalPath);
      const actualHash = createHash("sha256").update(fileContent).digest("hex");

      if (actualHash === row.sha256) {
        // Hash matches → promote to ACTIVE.
        this.repository.updateStatus(row.id, "ACTIVE");
        promoted++;
      } else {
        // Hash mismatch → mark as MISSING for diagnostics.
        this.repository.updateStatus(row.id, "MISSING");
        cleaned++;
      }
    }

    return { promoted, cleaned };
  }
}
