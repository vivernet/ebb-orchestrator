import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm, mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const launcher = join(root, "scripts", "run-server.js");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const serverManifest = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8"));

test("all server commands use the shared production and dev launcher", () => {
  assert.equal(rootManifest.scripts.start, "node scripts/run-server.js");
  assert.equal(rootManifest.scripts["server:dev"], "node scripts/run-server.js dev");
  assert.equal(serverManifest.scripts.start, "node ../../scripts/run-server.js");
  assert.equal(serverManifest.scripts.dev, "node ../../scripts/run-server.js dev");
});

test("launcher resolves its root and production target independently of caller cwd", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { getLaunchConfig } = await import(${JSON.stringify(pathToFileURL(launcher).href)});
    console.log(JSON.stringify(getLaunchConfig([])));
  `], { cwd: join(root, "apps/server"), encoding: "utf8", windowsHide: true });

  assert.equal(child.status, 0, child.stderr);
  const config = JSON.parse(child.stdout.trim());
  assert.equal(config.executable, "node");
  assert.deepEqual(config.args, [
    `--env-file-if-exists=${join(root, ".env")}`,
    join(root, "apps/server/dist/main.js"),
  ]);
  assert.equal(resolve(config.options.cwd), root);
  assert.equal(config.options.shell, false);
});

test("dev forwards arguments after the tsx watch entrypoint", async () => {
  const { getLaunchConfig } = await import(pathToFileURL(launcher));
  const config = getLaunchConfig(["dev", "--port", "4567", "--flag"]);
  assert.equal(config.executable, "node");
  assert.deepEqual(config.args, [
    `--env-file-if-exists=${join(root, ".env")}`,
    join(root, "node_modules/tsx/dist/cli.mjs"),
    "watch",
    join(root, "apps/server/src/main.ts"),
    "--port",
    "4567",
    "--flag",
  ]);
  assert.equal(resolve(config.options.cwd), root);
  assert.equal(config.options.shell, false);
});

test("dev launcher calls spawn with Node options before the tsx entrypoint", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ebb-launcher-spawn-"));
  const preload = join(temporaryDirectory, "capture-spawn.mjs");
  const capture = join(temporaryDirectory, "spawn.json");
  await writeFile(preload, `
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    childProcess.spawn = (command, args, options) => {
      writeFileSync(process.env.LAUNCH_CAPTURE, JSON.stringify({ command, args, cwd: options.cwd, shell: options.shell, inheritedEnv: options.env === process.env }));
      const child = new EventEmitter();
      process.nextTick(() => child.emit("exit", 0, null));
      return child;
    };
    syncBuiltinESMExports();
  `);
  try {
    const result = spawnSync(process.execPath, [launcher, "dev", "--listen", "localhost"], {
      cwd: join(root, "apps/server"),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        LAUNCH_CAPTURE: capture,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args, [
      `--env-file-if-exists=${join(root, ".env")}`,
      join(root, "node_modules/tsx/dist/cli.mjs"),
      "watch",
      join(root, "apps/server/src/main.ts"),
      "--listen",
      "localhost",
    ]);
    assert.equal(resolve(invocation.cwd), root);
    assert.equal(invocation.shell, false);
    assert.equal(invocation.inheritedEnv, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
test("actual launcher loads fixture root .env from both caller cwd values for prod and dev", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ebb-server-env-"));
  try {
    const serverRoot = join(fixtureRoot, "apps/server");
    const productionTarget = join(serverRoot, "dist/main.js");
    const devTarget = join(fixtureRoot, "node_modules/tsx/dist/cli.mjs");
    await mkdir(join(serverRoot, "dist"), { recursive: true });
    await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
    await mkdir(join(fixtureRoot, "node_modules/tsx/dist"), { recursive: true });
    await copyFile(launcher, join(fixtureRoot, "scripts/run-server.js"));
    const probe = `console.log(JSON.stringify({home: process.env.EBB_ORCHESTRATOR_HOME ?? 'app-default-home', port: process.env.PORT ?? 'app-default-port', cwd: process.cwd()}))`;
    await writeFile(productionTarget, probe);
    await writeFile(devTarget, `import { readFileSync } from 'node:fs';\n${probe}`);
    await writeFile(join(fixtureRoot, ".env"), "EBB_ORCHESTRATOR_HOME=file-home\nPORT=4321\n");

    for (const cwd of [fixtureRoot, serverRoot]) {
      for (const mode of ["production", "dev"]) {
        const args = mode === "dev" ? ["dev"] : [];
        const run = (overrides = {}) => spawnSync(process.execPath,
          [join(fixtureRoot, "scripts/run-server.js"), ...args], {
            cwd, encoding: "utf8", windowsHide: true,
            env: { ...process.env, EBB_ORCHESTRATOR_HOME: undefined, PORT: undefined, ...overrides },
          });
        const fileValues = run();
        assert.equal(fileValues.status, 0, fileValues.stderr);
        assert.deepEqual(JSON.parse(fileValues.stdout.trim()), {
          home: "file-home", port: "4321", cwd: fixtureRoot,
        });
        const processValues = run({ EBB_ORCHESTRATOR_HOME: "process-home", PORT: "9876" });
        assert.equal(processValues.status, 0, processValues.stderr);
        assert.deepEqual(JSON.parse(processValues.stdout.trim()), {
          home: "process-home", port: "9876", cwd: fixtureRoot,
        });
      }
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("missing fixture .env leaves defaults intact", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ebb-server-env-missing-"));
  try {
    const env = { ...process.env };
    delete env.PORT;
    const result = spawnSync(process.execPath, [
      `--env-file-if-exists=${join(fixtureRoot, ".env")}`,
      "--input-type=module", "-e", "console.log(process.env.PORT ?? '3000')",
    ], { cwd: fixtureRoot, encoding: "utf8", windowsHide: true, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "3000");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test(".env.example contains only safe settings and .env remains ignored", async () => {
  const example = await readFile(join(root, ".env.example"), "utf8");
  assert.match(example, /^EBB_ORCHESTRATOR_HOME=$/m);
  assert.match(example, /^# Windows: .+$/m);
  assert.match(example, /^# macOS: .+$/m);
  assert.match(example, /^# Linux: .+$/m);
  assert.match(example, /^PORT=3000$/m);
  assert.doesNotMatch(example, /(?:PASSWORD|SECRET|TOKEN|API_KEY)=\S+/i);
  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.env$/m);
  assert.doesNotMatch(gitignore, /^\.env\.example$/m);
});
