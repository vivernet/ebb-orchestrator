import { cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { ensureWindowsRunSupervisor } from "./package-native-assets.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(appRoot, "dist");
const migrations = resolve(appRoot, "src/platform/database/migrations");
if (!existsSync(migrations)) throw new Error("Migration directory is missing from server source");
cpSync(migrations, resolve(distRoot, "platform/database/migrations"), { recursive: true });

ensureWindowsRunSupervisor({
  platform: process.platform,
  serverRoot: appRoot,
  buildHelper: () => execFileSync(process.execPath, [resolve(appRoot, "scripts/build-windows-run-supervisor.mjs")], {
    cwd: appRoot,
    stdio: "inherit",
    windowsHide: true,
  }),
});
