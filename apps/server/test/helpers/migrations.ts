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
    .map((file) => ({
      version: Number(file.slice(0, 3)),
      name: file.slice(0, -4),
      sql: readFileSync(join(directory, file), "utf8"),
    }));
}
