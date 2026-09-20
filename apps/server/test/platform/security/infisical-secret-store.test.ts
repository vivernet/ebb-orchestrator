import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { InfisicalSecretStore, resolveInfisicalSecretStoreOptions, type InfisicalClient } from "../../../src/platform/security/infisical-secret-store.js";

const migrationDir = fileURLToPath(new URL("../../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => ({ version: Number(/^\d+/.exec(file)?.[0]), name: file, sql: readFileSync(join(migrationDir, file), "utf8") }));

function createClient(): { client: InfisicalClient; calls: string[]; values: Map<string, string> } {
  const calls: string[] = [];
  const values = new Map<string, string>();
  const client: InfisicalClient = {
    auth: () => ({ universalAuth: { login: async () => { calls.push("login"); } } }),
    secrets: () => ({
      getSecret: async ({ secretName }) => {
        const value = values.get(secretName);
        if (value === undefined) throw { statusCode: 404 };
        return { secretValue: value };
      },
      createSecret: async (secretName, { secretValue }) => { calls.push(`create:${secretName}`); values.set(secretName, secretValue); },
      updateSecret: async (secretName, { secretValue }) => { calls.push(`update:${secretName}`); values.set(secretName, secretValue ?? ""); },
      deleteSecret: async (secretName) => { calls.push(`delete:${secretName}`); values.delete(secretName); },
    }),
  };
  return { client, calls, values };
}

describe("InfisicalSecretStore", () => {
  it("requires complete explicit configuration before Infisical can replace the local keyring", () => {
    expect(resolveInfisicalSecretStoreOptions({ EBB_SECRET_BACKEND: "keyring" })).toBeUndefined();
    expect(() => resolveInfisicalSecretStoreOptions({ EBB_SECRET_BACKEND: "infisical" }))
      .toThrow("Infisical secret storage is misconfigured");
    expect(resolveInfisicalSecretStoreOptions({
      EBB_SECRET_BACKEND: "infisical",
      INFISICAL_CLIENT_ID: "client-id",
      INFISICAL_CLIENT_SECRET: "client-secret",
      INFISICAL_PROJECT_ID: "project-id",
      INFISICAL_ENVIRONMENT: "production",
    })).toMatchObject({ projectId: "project-id", environment: "production" });
  });

  it("authenticates once, stores remotely, and persists metadata only", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const { client, calls, values } = createClient();
    const store = new InfisicalSecretStore(db, client, {
      clientId: "client-id", clientSecret: "client-secret", projectId: "project-id", environment: "production", secretPath: "/orchestrator",
    });

    await store.store("github", "token", "secret-value");
    await store.store("github", "token", "rotated-value");

    expect(calls.filter((call) => call === "login")).toHaveLength(1);
    expect([...values.values()]).toEqual(["rotated-value"]);
    expect(JSON.stringify(db.all("SELECT * FROM secrets"))).not.toContain("rotated-value");
    await expect(store.resolveForService("github", "token")).resolves.toBe("rotated-value");
  });

  it("removes a newly created remote secret when metadata persistence fails", async () => {
    const { client, calls, values } = createClient();
    const failingDb = { run: () => { throw new Error("metadata failed"); } } as never;
    const store = new InfisicalSecretStore(failingDb, client, {
      clientId: "client-id", clientSecret: "client-secret", projectId: "project-id", environment: "production",
    });

    await expect(store.store("github", "token", "secret-value")).rejects.toThrow("metadata failed");
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(values).toEqual(new Map());
  });
});
