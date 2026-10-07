import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PinnedGitFixture {
  readonly sourceRoot: string;
  readonly originalModulePath: string;
  readonly originalResourcePath: string;
  readonly commit: string;
  readonly tree: string;
}

/** Creates an isolated local Git tree with a harmless Python module and adjacent resource. */
export async function createPinnedGitFixture(root: string): Promise<PinnedGitFixture> {
  const sourceRoot = join(root, "synthetic-hermes-source");
  await mkdir(sourceRoot, { recursive: true });
  const originalModulePath = join(sourceRoot, "marker_module.py");
  const originalResourcePath = join(sourceRoot, "adjacent-resource.txt");
  await writeFile(originalModulePath, "VALUE = 'snapshot-pinned-v1'\n", { encoding: "utf8" });
  await writeFile(originalResourcePath, "snapshot-resource-pinned-v1\n", { encoding: "utf8" });
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    ...(process.platform === "win32" ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "NUL",
    } : {}),
    GIT_AUTHOR_NAME: "Ebb acceptance fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Ebb acceptance fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await runGit(sourceRoot, ["init", "--template=", "--quiet"], env);
  await runGit(sourceRoot, ["add", "--", "marker_module.py", "adjacent-resource.txt"], env);
  await runGit(sourceRoot, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic Hermes source"], env);
  const commit = (await runGit(sourceRoot, ["rev-parse", "HEAD"], env)).trim();
  const tree = (await runGit(sourceRoot, ["rev-parse", "HEAD^{tree}"], env)).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) || tree.length !== commit.length ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Error("SOURCE_ACCEPTANCE_GIT_IDENTITY_INVALID");
  return { sourceRoot, originalModulePath, originalResourcePath, commit, tree };
}

/** Waits for an exact fixture-owned marker without treating timeout as process-stop evidence. */
export async function waitForFile(pathname: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(pathname); return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("SOURCE_ACCEPTANCE_MARKER_TIMEOUT");
}

async function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const command = process.platform === "win32" ? "git.exe" : "git";
  const child = spawn(command, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`SOURCE_ACCEPTANCE_GIT_FAILED:${args[0]}`);
  if (stderr.length > 0) throw new Error(`SOURCE_ACCEPTANCE_GIT_STDERR:${args[0]}`);
  return stdout;
}
