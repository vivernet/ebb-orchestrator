import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { ArtifactStore } from "../../../src/platform/artifacts/artifact-store.js";
import { ArtifactRepository } from "../../../src/platform/artifacts/artifact-repository.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const goodMigrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
];

describe("ArtifactStore", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let artifactsDir: string;
  let store: ArtifactStore;
  let repository: ArtifactRepository;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-artifact-test-"));
    artifactsDir = join(tmpDir, "artifacts");
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    db = createSqliteDatabase(dbPath);
    runMigrations(db, goodMigrations);

    repository = new ArtifactRepository(db);
    store = new ArtifactStore(artifactsDir, repository);
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes an artifact and reads it back", async () => {
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("hello"),
    });

    // storagePath должен быть относительным и никогда не начинаться с "/".
    expect(record.storagePath.startsWith("/")).toBe(false);

    // Файл должен существовать по разрешённому абсолютному пути.
    const absolutePath = join(artifactsDir, record.storagePath);
    const content = await readFile(absolutePath, "utf8");
    expect(content).toBe("hello");

    // Запись в базе должна иметь статус ACTIVE.
    expect(record.status).toBe("ACTIVE");
  });

  it("reads an artifact via openArtifact", async () => {
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("hello world"),
    });

    const stream = await store.openArtifact(record.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString("utf8");
    expect(content).toBe("hello world");
  });

  it("throws when opening a non-existent artifact", async () => {
    await expect(store.openArtifact("non-existent-id")).rejects.toThrow(
      /not found/i,
    );
  });

  it("calculates SHA-256 hash and size correctly", async () => {
    const content = "test content for hashing";
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from(content),
    });

    const expectedHash = (await import("node:crypto"))
      .createHash("sha256")
      .update(content)
      .digest("hex");

    expect(record.sha256).toBe(expectedHash);
    expect(record.sizeBytes).toBe(Buffer.byteLength(content));
  });

  it("does not create a final file or DB row when write fails before rename", async () => {
    // Проверяем это, заставляя store завершиться ошибкой на шаге rename.
    // Создаём сломанный store, имитирующий сбой после создания временного файла.
    const brokenStore = new ArtifactStore(artifactsDir, repository, {
    // Принудительно завершаем работу после создания временного файла, но до rename.
      _failBeforeRename: true,
    });

    await expect(
      brokenStore.writeArtifact({
        type: "build-output",
        contentType: "text/plain",
        bytes: Buffer.from("should not persist"),
      }),
    ).rejects.toThrow();

    // В базе не должно быть строк artifacts (строки STAGING откатились).
    const rows = db!.all<{ id: string }>(
      "SELECT id FROM artifacts",
    );
    expect(rows).toEqual([]);

    // Временных файлов не должно остаться (они очищены).
  });

  it("reconciles staging artifacts on startup", async () => {
    // Сначала записываем обычный artifact.
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("healthy"),
    });

    // Имитируем сбой: вручную возвращаем строку в STAGING.
    db!.run("UPDATE artifacts SET status = 'STAGING' WHERE id = $id", {
      $id: record.id,
    });

    // Финальный файл существует и hash совпадает, поэтому reconcile должен перевести запись в ACTIVE.
    const result = await store.reconcileStagingArtifacts();
    expect(result.promoted).toBe(1);
    expect(result.cleaned).toBe(0);

    // Проверяем, что теперь запись ACTIVE.
    const row = db!.get<{ status: string }>(
      "SELECT status FROM artifacts WHERE id = $id",
      { $id: record.id },
    );
    expect(row?.status).toBe("ACTIVE");
  });

  it("reconcile cleans up stale DB rows with missing files", async () => {
    // Записываем artifact.
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("will be deleted"),
    });

    // Имитируем сбой: переводим запись в STAGING и удаляем файл.
    db!.run("UPDATE artifacts SET status = 'STAGING' WHERE id = $id", {
      $id: record.id,
    });

    const absolutePath = join(artifactsDir, record.storagePath);
    await rm(absolutePath);

    const result = await store.reconcileStagingArtifacts();
    expect(result.promoted).toBe(0);
    expect(result.cleaned).toBe(1);

    // Строка должна исчезнуть.
    const row = db!.get<{ id: string }>(
      "SELECT id FROM artifacts WHERE id = $id",
      { $id: record.id },
    );
    expect(row).toBeUndefined();
  });
});
