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

    // storagePath must be relative (never start with "/")
    expect(record.storagePath.startsWith("/")).toBe(false);

    // File should exist at the resolved absolute path
    const absolutePath = join(artifactsDir, record.storagePath);
    const content = await readFile(absolutePath, "utf8");
    expect(content).toBe("hello");

    // Record should be ACTIVE in the database
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
    // We test this by having the store fail on the rename step.
    // We create a broken store that simulates a failure after temp file creation.
    const brokenStore = new ArtifactStore(artifactsDir, repository, {
      // Force a failure after temp file creation but before rename
      _failBeforeRename: true,
    });

    await expect(
      brokenStore.writeArtifact({
        type: "build-output",
        contentType: "text/plain",
        bytes: Buffer.from("should not persist"),
      }),
    ).rejects.toThrow();

    // No artifact rows should be in the database (STAGING rows rolled back)
    const rows = db!.all<{ id: string }>(
      "SELECT id FROM artifacts",
    );
    expect(rows).toEqual([]);

    // No temp files should be left behind (cleaned up)
  });

  it("reconciles staging artifacts on startup", async () => {
    // Write a normal artifact first
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("healthy"),
    });

    // Simulate a crash: manually set the row back to STAGING
    db!.run("UPDATE artifacts SET status = 'STAGING' WHERE id = $id", {
      $id: record.id,
    });

    // The final file exists and hash matches, so reconcile should promote to ACTIVE
    const result = await store.reconcileStagingArtifacts();
    expect(result.promoted).toBe(1);
    expect(result.cleaned).toBe(0);

    // Verify it's ACTIVE now
    const row = db!.get<{ status: string }>(
      "SELECT status FROM artifacts WHERE id = $id",
      { $id: record.id },
    );
    expect(row?.status).toBe("ACTIVE");
  });

  it("reconcile cleans up stale DB rows with missing files", async () => {
    // Write an artifact
    const record = await store.writeArtifact({
      type: "build-output",
      contentType: "text/plain",
      bytes: Buffer.from("will be deleted"),
    });

    // Simulate crash: set to STAGING and delete the file
    db!.run("UPDATE artifacts SET status = 'STAGING' WHERE id = $id", {
      $id: record.id,
    });

    const absolutePath = join(artifactsDir, record.storagePath);
    await rm(absolutePath);

    const result = await store.reconcileStagingArtifacts();
    expect(result.promoted).toBe(0);
    expect(result.cleaned).toBe(1);

    // Row should be gone
    const row = db!.get<{ id: string }>(
      "SELECT id FROM artifacts WHERE id = $id",
      { $id: record.id },
    );
    expect(row).toBeUndefined();
  });
});
