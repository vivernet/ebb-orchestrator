import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 8 * 1024;
const GIT_TIMEOUT_MS = 5_000;

/**
 * Проверяет, что заданный Hermes checkout остаётся на ожидаемом Git commit без изменений.
 * Выполняет только локальные read-only Git команды с `shell:false`; Hermes configuration,
 * auth и ACL не читаются. Проверка учитывает tracked изменения и обычные untracked файлы.
 * Предусловие Plan20: пользователь не обновляет pinned source от финальной проверки
 * непосредственно перед импортом до завершения Run; проверка не блокирует внешние writers.
 *
 * @param sourceRoot Физический корень установленного Hermes source.
 * @param expectedCommit Commit, закреплённый для поддерживаемого Hermes build.
 * @throws {Error} Если checkout нельзя однозначно прочитать, он грязный или commit изменился.
 */
export async function verifyHermesSourceCheckout(sourceRoot: string, expectedCommit: string): Promise<void> {
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit)) throw new Error("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
  try {
    const gitRoot = await git(sourceRoot, ["rev-parse", "--show-toplevel"]);
    const [resolvedRoot, resolvedGitRoot] = await Promise.all([realpath(sourceRoot), realpath(gitRoot.trim())]);
    if (!samePhysicalPath(resolvedRoot, resolvedGitRoot)) throw new Error("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
    const head = (await git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
    if (head !== expectedCommit) throw new Error("HERMES_SOURCE_IDENTITY_MISMATCH");
    if ((await git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"])) !== "") {
      throw new Error("HERMES_SOURCE_IDENTITY_DIRTY");
    }
  } catch (error) {
    if (error instanceof Error && [
      "HERMES_SOURCE_IDENTITY_UNAVAILABLE", "HERMES_SOURCE_IDENTITY_MISMATCH", "HERMES_SOURCE_IDENTITY_DIRTY",
    ].includes(error.message)) throw error;
    throw unavailableSourceIdentity();
  }
}

function unavailableSourceIdentity(): Error {
  // Raw child-process error содержит stdout/stderr; он не должен попасть в Run diagnostics.
  return new Error("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
}

async function git(sourceRoot: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Whitelist не наследует ни одну GIT_* override из родительского процесса.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_SYSTEM = env.GIT_CONFIG_GLOBAL;
  const result = await execFileAsync("git", [
    "--no-optional-locks", "--no-replace-objects",
    "-c", "core.excludesFile=", "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "core.ignoreStat=false",
    "-C", sourceRoot, ...args,
  ], {
    env,
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
  if (result.stderr !== "" || result.stdout.length > GIT_OUTPUT_LIMIT) throw new Error("GIT_OUTPUT_INVALID");
  return result.stdout;
}

function samePhysicalPath(left: string, right: string): boolean {
  const normalize = process.platform === "win32" ? (value: string) => path.win32.normalize(value).toLocaleLowerCase("en-US") : path.posix.normalize;
  return normalize(left) === normalize(right);
}
