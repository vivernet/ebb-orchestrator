import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { createAuthRepository } from "../../../src/platform/security/auth-repository.js";
import type { Database } from "../../../src/platform/database/database.js";
import type { PasswordHasher } from "../../../src/platform/security/auth-ports.js";
import { createNodeDigestPort } from "../../../src/platform/security/auth-ports.js";

const PHC = "$argon2id$v=19$m=65536,p=4,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const hasher: PasswordHasher = { hash: async () => PHC, verify: async () => true };

export function backupSqliteDatabase(sourcePath: string, backupPath: string): void {
  copyFileSync(sourcePath, backupPath);
}

export function restoreSqliteDatabase(backupPath: string, sourcePath: string): void {
  copyFileSync(backupPath, sourcePath);
}

describe("SQLite auth backup and forward recovery", () => {
  let database: Database | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("restores a closed pre-migration backup and reruns forward migrations", async () => {
    directory = await mkdtemp(join(tmpdir(), "ebb-auth-backup-"));
    const sourcePath = join(directory, "source.sqlite");
    const backupPath = join(directory, "backup.sqlite");
    database = createSqliteDatabase(sourcePath);
    runMigrations(database, loadTestMigrations());
    const auth = createAuthRepository(database, hasher, { randomBytes: () => new Uint8Array(32).fill(1) }, createNodeDigestPort());
    await auth.createLocalUser(new Uint8Array([1]), "2030-01-01T00:00:00.000Z");
    database.run(
      `INSERT INTO projects (id, name, display_name, created_at, updated_at) VALUES ($id, $name, $displayName, $now, $now)`,
      { id: "backup-project", name: "backup", displayName: "backup", now: "2030-01-01T00:00:00.000Z" },
    );
    database.run(
      `INSERT INTO onboarding_configs (project_id, repository_path, facts_json, proposed_json, created_at, updated_at)
       VALUES ($projectId, $repositoryPath, $factsJson, $proposedJson, $now, $now)`,
      { projectId: "backup-project", repositoryPath: "C:/repo", factsJson: "{}", proposedJson: "{}", now: "2030-01-01T00:00:00.000Z" },
    );
    database.close();
    database = undefined;
    backupSqliteDatabase(sourcePath, backupPath);

    const backup = createSqliteDatabase(backupPath);
    expect(backup.get("SELECT id FROM local_users")).toEqual({ id: 1 });
    expect(backup.get("SELECT project_id FROM onboarding_configs")).toEqual({ project_id: "backup-project" });
    backup.close();

    const failed = createSqliteDatabase(sourcePath);
    expect(() => runMigrations(failed, [...loadTestMigrations(), { version: 27, name: "027_injected_failure", sql: "CREATE TABLE partial_recovery (id TEXT); SELECT broken_recovery_sql;" }])).toThrow();
    failed.close();
    restoreSqliteDatabase(backupPath, sourcePath);

    database = createSqliteDatabase(sourcePath);
    expect(runMigrations(database, loadTestMigrations()).applied).toBe(0);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM local_users")?.count).toBe(1);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM onboarding_configs")?.count).toBe(1);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='partial_recovery'")?.count).toBe(0);
  });
});
