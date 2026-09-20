import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(appRoot, "dist");
const migrations = resolve(appRoot, "src/platform/database/migrations");
if (!existsSync(migrations)) throw new Error("Migration directory is missing from server source");
cpSync(migrations, resolve(distRoot, "platform/database/migrations"), { recursive: true });
