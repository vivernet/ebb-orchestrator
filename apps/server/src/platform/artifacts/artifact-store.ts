/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import { randomUUID, createHash } from "node:crypto";
import { open, rename, unlink, access, mkdir, readFile, readdir, rmdir } from "node:fs/promises";
import { createReadStream, lstatSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { ArtifactRepository } from "./artifact-repository.js";
import { PathResolver } from "../security/path-resolver.js";

/** Публичный интерфейс, возвращаемый вызывающему коду. */
export interface ArtifactRecord {
  id: string;
  type: string;
  storagePath: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  status: string;
}

/** Входные данные для записи нового артефакта. */
export interface WriteArtifactInput {
  type: string;
  contentType?: string | null;
  bytes: Buffer;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  expiresAt?: string | null;
}

/** Результат прохода reconciliation. */
export interface ReconcileResult {
  /** Количество staging-строк, переведённых в ACTIVE. */
  promoted: number;
  /** Количество удалённых устаревших строк. */
  cleaned: number;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export interface ArtifactStoreOptions {
  _failBeforeRename?: boolean;
}

/**
 * Предоставляет публичный контракт модуля artifact-store для взаимодействия слоёв приложения.
 */
export class ArtifactStore {
  private readonly pathResolver = new PathResolver();
  constructor(
    private readonly artifactsDir: string,
    private readonly repository: ArtifactRepository,
    private readonly options?: ArtifactStoreOptions,
  ) {}

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Выполняет соответствующую проверку или действие согласно контракту.
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const sizeBytes = input.bytes.length;

    // Выполняет соответствующую проверку или действие согласно контракту.
    // Выполняет соответствующую проверку или действие согласно контракту.
    const relativePath = `${id}/artifact`;

    const absoluteFinalPath = join(this.artifactsDir, relativePath);
    const parentDir = join(this.artifactsDir, id);
    const tempPath = `${absoluteFinalPath}.${randomUUID()}.tmp`;

    // Выполняет соответствующую проверку или действие согласно контракту.
    await mkdir(parentDir, { recursive: true });

    // Выполняет соответствующую проверку или действие согласно контракту.
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
    if (this.options?._failBeforeRename) {
      // Выполняет соответствующую проверку или действие согласно контракту.
      await unlink(tempPath).catch(() => {});
      throw new Error("Simulated failure before rename");
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
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

    // Выполняет соответствующую проверку или действие согласно контракту.
    await rename(tempPath, absoluteFinalPath);

    // Выполняет соответствующую проверку или действие согласно контракту.
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
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  async openArtifact(id: string): Promise<Readable> {
    const row = this.repository.getById(id);
    if (!row || row.status !== "ACTIVE") {
      throw new Error(`Artifact not found: ${id}`);
    }

    const absolutePath = this.resolveRegularArtifactPath(row.relative_path);

    return createReadStream(absolutePath);
  }

  /**
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   *
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   * Описывает соответствующий контракт, инвариант или этап выполнения.
   */
  async reconcileStagingArtifacts(): Promise<ReconcileResult> {
    const staging = this.repository.getByStatus("STAGING");
    let promoted = 0;
    let cleaned = 0;

    for (const row of staging) {
      const lexicalPath = join(this.artifactsDir, row.relative_path);
      let absoluteFinalPath: string;
      try {
        lstatSync(lexicalPath);
        absoluteFinalPath = this.resolveRegularArtifactPath(row.relative_path);
      } catch (error) {
        if (isMissingPath(error, lexicalPath)) {
          this.repository.deleteById(row.id);
          const parentDir = join(this.artifactsDir, row.id);
          try {
            const files = await readdir(parentDir);
            for (const f of files) if (f.endsWith(".tmp")) await unlink(join(parentDir, f)).catch(() => {});
            await rmdir(parentDir).catch(() => {});
          } catch { /* orphan directory may already be gone */ }
          cleaned++;
          continue;
        }
        this.repository.updateStatus(row.id, "MISSING");
        cleaned++;
        continue;
      }

      // Выполняет соответствующую проверку или действие согласно контракту.
      let fileExists = false;
      try {
        await access(absoluteFinalPath);
        fileExists = true;
      } catch {
        // Выполняет соответствующую проверку или действие согласно контракту.
      }

      if (!fileExists) {
        // Выполняет соответствующую проверку или действие согласно контракту.
        this.repository.deleteById(row.id);

        // Выполняет соответствующую проверку или действие согласно контракту.
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
          // Выполняет соответствующую проверку или действие согласно контракту.
        }

        cleaned++;
        continue;
      }

      // Выполняет соответствующую проверку или действие согласно контракту.
      const fileContent = await readFile(absoluteFinalPath);
      const actualHash = createHash("sha256").update(fileContent).digest("hex");

      if (actualHash === row.sha256) {
        // Выполняет соответствующую проверку или действие согласно контракту.
        this.repository.updateStatus(row.id, "ACTIVE");
        promoted++;
      } else {
        // Выполняет соответствующую проверку или действие согласно контракту.
        this.repository.updateStatus(row.id, "MISSING");
        cleaned++;
      }
    }

    return { promoted, cleaned };
  }

  private resolveRegularArtifactPath(relativePath: string): string {
    const resolved = this.pathResolver.resolveSafePathSync(this.artifactsDir, relativePath);
    if (!resolved.success || !resolved.path || !this.pathResolver.isPathContained(this.artifactsDir, resolved.path)) {
      throw new Error("Artifact path is outside managed root");
    }
    const absolute = join(this.artifactsDir, relativePath);
    const stat = requireLstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artifact path is not a regular file");
    return resolved.path;
  }
}

function requireLstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean } {
  // Выполняет соответствующую проверку или действие согласно контракту.
  // Выполняет соответствующую проверку или действие согласно контракту.
  return lstatSync(path);
}

function isMissingPath(error: unknown, path: string): boolean {
  try { lstatSync(path); return false; } catch { return true; }
}
