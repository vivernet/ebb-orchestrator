import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Migration } from "../../src/platform/database/migrator.js";

/**
 * Загружает непрерывный каталог миграций для test-only bootstrap.
 * Production migrator при этом вызывается тем же способом, что и в runtime.
 */
export function loadTestMigrations(): Migration[] {
  const directory = join(import.meta.dirname, "../../src/platform/database/migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const name = file.slice(0, -4);
      const migration = {
        version: Number(file.slice(0, 3)),
        name,
        sql: readFileSync(join(directory, file), "utf8"),
      };
      return name === "027_approval_changes_requested"
        ? { ...migration, foreignKeys: "disabled" as const }
        : migration;
    });
}
