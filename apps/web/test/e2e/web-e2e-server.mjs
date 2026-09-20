import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "vite";

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const port = Number(argument("--port"));
const bootstrapFile = argument("--bootstrap-file");
const webRoot = resolve(import.meta.dirname, "../..");
const serverRoot = resolve(webRoot, "../server");
const vite = await createServer({
  root: serverRoot,
  configFile: false,
  appType: "custom",
  server: {
    middlewareMode: true,
    hmr: false,
    fs: { allow: [serverRoot, resolve(serverRoot, "../..")] },
  },
});

const [
  { createApp },
  { createSqliteDatabase },
  { runMigrations },
  { SchedulerService },
] = await Promise.all([
  vite.ssrLoadModule("/src/app/create-app.ts"),
  vite.ssrLoadModule("/src/platform/database/sqlite-database.ts"),
  vite.ssrLoadModule("/src/platform/database/migrator.ts"),
  vite.ssrLoadModule("/src/modules/scheduler/scheduler-service.ts"),
]);

const migrationDirectory = join(serverRoot, "src/platform/database/migrations");
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => ({
    version: Number(/^(\d+)_/.exec(file)?.[1]),
    name: file,
    sql: readFileSync(join(migrationDirectory, file), "utf8"),
  }));
const runtime = {
  active: 0,
  maxActive: 0,
  calls: [],
  async startRun() {},
  async runResult() { return {}; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return {}; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};
const database = createSqliteDatabase(":memory:");
runMigrations(database, migrations);
const app = createApp({
  host: "127.0.0.1",
  port,
  db: database,
  scheduler: new SchedulerService(database),
  runtime,
});
if (!app.bootstrapToken) throw new Error("E2E app did not issue a bootstrap token");
mkdirSync(dirname(bootstrapFile), { recursive: true });
writeFileSync(bootstrapFile, JSON.stringify({ bootstrapToken: app.bootstrapToken }), { encoding: "utf8", mode: 0o600 });
await app.listen({ host: "127.0.0.1", port });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  database.close();
  await vite.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown();
  });
}
