import { constants as fsConstants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHermesSourceCheckout } from "./hermes-source-integrity.js";
import type { HermesLaunchObjectIdentity } from "./hermes-launch-ticket.js";
import type { ProcessOptions, ProcessResult } from "../../../platform/process/process-executor.js";
import { verifyNativeHelperIntegrity } from "../../../platform/process/native-helper-integrity.js";
import { runVerifiedNativeHelper } from "../../../platform/process/native-helper-launcher.js";

/** Пути установленного Hermes и Python; credentials/configuration resolver не читает. */
export interface HermesExecutableResolution {
  readonly executablePath: string;
  readonly executableIdentity: HermesLaunchObjectIdentity;
  readonly runtimeExecutablePath: string;
  readonly runtimeExecutableIdentity: HermesLaunchObjectIdentity;
  readonly hermesProjectRoot: string;
  /** Фактический install-stamp commit, подтверждённый по HEAD и clean status checkout. */
  readonly sourceCommit: string;
  readonly hermesConfigHome: string;
}

export interface HermesResolverCommandOptions extends ProcessOptions {
  readonly shell: false;
}

export interface HermesExecutableResolverOptions {
  readonly cwd?: string;
  readonly pathValue?: string;
  readonly platform?: "win32" | "linux";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam для native identity probe; shell всегда false. */
  readonly runNativePathVerifier?: (
    file: string, args: string[], options: HermesResolverCommandOptions,
  ) => Promise<ProcessResult>;
  readonly verifyNativeHelper?: typeof verifyNativeHelperIntegrity;
  /** Test seam для checkout integrity; production проверяет локальный Git checkout. */
  readonly verifySourceCheckout?: typeof verifyHermesSourceCheckout;
}

type Platform = "win32" | "linux";
type PlatformPaths = typeof path.win32 | typeof path.posix;

// Budget включает холодный запуск PowerShell integrity gate перед native identity probe.
const WINDOWS_PATH_IDENTITY_TIMEOUT_MS = 15_000;

/**
 * Находит установленный Hermes в PATH и его обычный Python runtime.
 * Читает только install metadata для выбора interpreter; пользовательские config/profile/auth
 * не открывает. На Windows native helper возвращает file identity без ACL admission.
 * Текущий install stamp задаёт source commit; HEAD и clean status checkout подтверждают
 * эту identity для конкретного Run.
 *
 * @throws {Error} При отсутствующем/неоднозначном launcher или неподдерживаемой installation layout.
 */
export async function resolveHermesExecutable(
  options: HermesExecutableResolverOptions = {},
): Promise<HermesExecutableResolution> {
  const platform = options.platform ?? currentPlatform();
  const paths = platform === "win32" ? path.win32 : path.posix;
  const environment = options.environment ?? process.env;
  const cwd = await existingDirectory(options.cwd ?? process.cwd(), paths);
  const executablePath = await findLauncher(options.pathValue ?? environment.PATH ?? "", cwd, platform);
  const hermesProjectRoot = platform === "win32"
    ? await windowsSourceRoot(executablePath, cwd)
    : await linuxSourceRoot(executablePath, cwd);
  const sourceCommit = await readInstalledSourceCommit(hermesProjectRoot);
  await verifyResolvedSource(hermesProjectRoot, sourceCommit, options);
  const hermesConfigHome = platform === "win32"
    ? resolveWindowsHermesConfigHome(environment)
    : resolveLinuxHermesConfigHome(environment);
  const runtime = platform === "win32"
    ? await windowsRuntime(hermesProjectRoot)
    : await linuxRuntime(hermesProjectRoot, hermesConfigHome, environment);
  const executableIdentity = await fileIdentity(executablePath, platform, cwd, options);
  const runtimeExecutableIdentity = await fileIdentity(runtime.pythonExecutable, platform, cwd, options);
  return Object.freeze({
    executablePath,
    executableIdentity,
    runtimeExecutablePath: runtime.pythonExecutable,
    runtimeExecutableIdentity,
    hermesProjectRoot,
    sourceCommit,
    hermesConfigHome,
  });
}

async function readInstalledSourceCommit(sourceRoot: string): Promise<string> {
  let stamp: Record<string, unknown>;
  try {
    stamp = record(JSON.parse((await readBoundedFile(path.join(sourceRoot, "install-stamp.json"), 64 * 1024)).toString("utf8").replace(/^\uFEFF/u, "")) as unknown);
  } catch {
    throw resolverError("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
  }
  const commit = stamp.commit;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw resolverError("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
  }
  return commit;
}

async function verifyResolvedSource(
  sourceRoot: string,
  expectedCommit: string,
  options: HermesExecutableResolverOptions,
): Promise<void> {
  await (options.verifySourceCheckout ?? verifyHermesSourceCheckout)(sourceRoot, expectedCommit);
}

async function findLauncher(pathValue: string, cwd: string, platform: Platform): Promise<string> {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const matches = new Map<string, string>();
  for (const entry of pathValue.split(paths.delimiter)) {
    if (!paths.isAbsolute(entry) || hasControlCharacters(entry)) continue;
    const directory = await realpath(entry).catch(() => undefined);
    if (!directory || isWithin(cwd, directory, paths)) continue;
    for (const name of platform === "win32" ? ["hermes.cmd", "hermes.exe"] : ["hermes"]) {
      const candidate = await existingFile(paths.join(directory, name), paths).catch(() => undefined);
      if (!candidate || isWithin(cwd, candidate, paths)) continue;
      if (platform === "linux" && !(await access(candidate, fsConstants.X_OK).then(() => true, () => false))) continue;
      matches.set(platform === "win32" ? candidate.toLowerCase() : candidate, candidate);
      break;
    }
  }
  if (matches.size === 0) throw resolverError("HERMES_LAUNCHER_NOT_FOUND");
  if (matches.size !== 1) throw resolverError("HERMES_LAUNCHER_AMBIGUOUS");
  return [...matches.values()][0]!;
}

async function windowsSourceRoot(launcher: string, cwd: string): Promise<string> {
  const paths = path.win32;
  if (paths.basename(paths.dirname(launcher)).toLowerCase() !== "bin") {
    throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  }
  const source = await existingDirectory(paths.join(paths.dirname(paths.dirname(launcher)), "hermes-agent"), paths);
  if (isWithin(cwd, source, paths)) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  await existingFile(paths.join(source, "hermes_cli", "main.py"), paths);
  return source;
}

async function linuxSourceRoot(launcher: string, cwd: string): Promise<string> {
  let inner = launcher;
  if (!inner.endsWith("/.hermes/bin/hermes")) {
    const script = (await readBoundedFile(inner, 64 * 1024)).toString("utf8");
    const match = /^#!\/bin\/sh\r?\nexec (?:'([^'\r\n]+)'|([^\s'"\r\n]+)) "\$@"\r?\n?$/u.exec(script);
    if (!match) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
    inner = await existingFile(match[1] ?? match[2] ?? "", path.posix);
  }
  if (!inner.endsWith("/.hermes/bin/hermes")) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  const source = await existingDirectory(path.posix.dirname(path.posix.dirname(path.posix.dirname(inner))), path.posix);
  if (isWithin(cwd, source, path.posix)) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  await existingFile(path.posix.join(source, "hermes_cli", "main.py"), path.posix);
  return source;
}

async function windowsRuntime(source: string): Promise<{ pythonExecutable: string }> {
  const paths = path.win32;
  const key = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const state = paths.join(paths.dirname(source), "installs", key);
  const facts = await readJson(paths.join(state, "facts.json"));
  const venv = record(facts.packages).venv;
  const dependencyRoot = record(venv).environment;
  if (typeof dependencyRoot !== "string" || !isWithin(paths.join(state, "environments"), dependencyRoot, paths)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const canonicalVenv = await existingDirectory(dependencyRoot, paths);
  await existingFile(paths.join(canonicalVenv, "pyvenv.cfg"), paths);
  const pythonExecutable = await existingFile(paths.join(canonicalVenv, "Scripts", "python.exe"), paths);
  return { pythonExecutable };
}

async function linuxRuntime(
  source: string, home: string, environment: Readonly<Record<string, string | undefined>>,
): Promise<{ pythonExecutable: string }> {
  const stamp = await readJson(path.posix.join(source, "install-stamp.json"));
  const stampedRoot = typeof stamp.runtimeDir === "string" ? stamp.runtimeDir : undefined;
  const store = await existingDirectory(environment.HERMES_RUNTIME_DIR?.trim() || stampedRoot || path.posix.join(home, "tools"), path.posix);
  const facts = await readJson(path.posix.join(store, "facts.json"));
  const entry = record(record(facts.packages).python).entry;
  if (typeof entry !== "string" || !entry || path.posix.isAbsolute(entry) ||
      entry.split("/").some((component) => !component || component === "." || component === "..")) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const dependencyRoot = await existingDirectory(path.posix.join(store, entry), path.posix);
  const pythonExecutable = await existingFile(path.posix.join(dependencyRoot, "bin", "python3"), path.posix);
  return { pythonExecutable };
}

async function fileIdentity(
  filename: string, platform: Platform, cwd: string, options: HermesExecutableResolverOptions,
): Promise<HermesLaunchObjectIdentity> {
  if (platform === "linux") {
    const details = await stat(filename, { bigint: true });
    if (!details.isFile()) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    return Object.freeze({ platform, device: details.dev.toString(), inode: details.ino.toString() });
  }
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../dist/native/hermes-profile-path/ebb-hermes-profile-path.exe");
  await (options.verifyNativeHelper ?? verifyNativeHelperIntegrity)(helper, "hermesProfilePath");
  const runner = options.runNativePathVerifier ?? (async (file, args, input) => {
    const { shell: _shell, ...processOptions } = input;
    void _shell;
    return runVerifiedNativeHelper(file, "hermesProfilePath", args, processOptions);
  });
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const result = await runner(helper, ["verify-host-path", "file", filename], {
    shell: false, cwd,
    env: systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.win32.join(systemRoot, "System32") } : {},
    timeout: WINDOWS_PATH_IDENTITY_TIMEOUT_MS, maxBuffer: 2_048,
  });
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > 2_048) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(result.stdout) as unknown); }
  catch { throw resolverError("HERMES_PATH_IDENTITY_INVALID"); }
  const reported = typeof value.path === "string" ? value.path.replace(/^\\\\\?\\/u, "") : "";
  if (value.status !== "SAFE_PATH" || value.kind !== "file" || reported.toLowerCase() !== filename.toLowerCase() ||
      typeof value.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(value.volumeSerial) ||
      typeof value.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(value.fileId)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return Object.freeze({ platform, volumeSerial: value.volumeSerial, fileId: value.fileId });
}

async function readJson(filename: string): Promise<Record<string, unknown>> {
  try { return record(JSON.parse((await readBoundedFile(filename, 1024 * 1024)).toString("utf8").replace(/^\uFEFF/u, "")) as unknown); }
  catch { throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED"); }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  return value as Record<string, unknown>;
}

async function readBoundedFile(filename: string, limit: number): Promise<Buffer> {
  const handle = await open(filename, fsConstants.O_RDONLY);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (bytesRead !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
    }
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function existingFile(value: string, paths: PlatformPaths): Promise<string> {
  if (!paths.isAbsolute(value) || hasControlCharacters(value)) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isFile()) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  return canonical;
}

async function existingDirectory(value: string, paths: PlatformPaths): Promise<string> {
  if (!paths.isAbsolute(value) || hasControlCharacters(value)) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  return canonical;
}

function currentPlatform(): Platform {
  if (process.platform === "win32" || process.platform === "linux") return process.platform;
  throw resolverError("HERMES_PLATFORM_UNSUPPORTED");
}

function isWithin(parent: string, candidate: string, paths: PlatformPaths): boolean {
  const relative = paths.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

function resolverError(code: string): Error { return new Error(code); }

/** Разрешает существующий Windows Hermes home только по переменным окружения. */
export function resolveWindowsHermesConfigHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const paths = path.win32;
  const userHome = environment.USERPROFILE ??
    (environment.HOMEDRIVE && environment.HOMEPATH ? `${environment.HOMEDRIVE}${environment.HOMEPATH}` : "");
  const localAppData = environment.LOCALAPPDATA?.trim() || (userHome ? paths.join(userHome, "AppData", "Local") : "");
  const suffix = environment.HERMES_DATA_DIR_SUFFIX ?? "";
  if (!paths.isAbsolute(localAppData) || hasControlCharacters(localAppData) ||
      !/^[A-Za-z0-9._-]*$/u.test(suffix)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  const defaultRoot = paths.normalize(paths.join(localAppData, `hermes${suffix}`));
  const override = environment.HERMES_HOME?.trim();
  if (!override) return defaultRoot;
  if (hasControlCharacters(override)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  let expanded = override.replace(/%([A-Za-z_][A-Za-z0-9_]*)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, percent: string | undefined, braced: string | undefined, plain: string | undefined) => {
      const value = environment[percent ?? braced ?? plain ?? ""];
      if (value === undefined || hasControlCharacters(value)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
      return value;
    });
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    if (!paths.isAbsolute(userHome) || hasControlCharacters(userHome)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
    expanded = expanded.length === 1 ? userHome : paths.join(userHome, expanded.slice(2));
  } else if (expanded.startsWith("~")) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  if (expanded.includes("$") || expanded.includes("%") || !paths.isAbsolute(expanded)) {
    throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  }
  const candidate = paths.normalize(expanded);


  return candidate;
}

/** Применяет только path-resolution правила Hermes для Linux HERMES_HOME. */
export function resolveLinuxHermesConfigHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const nativeHome = environment.HOME?.trim() ?? "";
  const suffix = environment.HERMES_DATA_DIR_SUFFIX ?? "";
  if (!path.posix.isAbsolute(nativeHome) || hasControlCharacters(nativeHome) ||
      !/^[A-Za-z0-9._-]*$/u.test(suffix)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  const defaultRoot = path.posix.normalize(path.posix.join(nativeHome, `.hermes${suffix}`));
  const override = environment.HERMES_HOME?.trim();
  if (!override) return defaultRoot;
  if (hasControlCharacters(override)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  let expanded = override;
  if (expanded === "~") expanded = nativeHome;
  else if (expanded.startsWith("~/")) expanded = path.posix.join(nativeHome, expanded.slice(2));
  else if (expanded.startsWith("~")) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced: string | undefined, plain: string | undefined) => {
    const value = environment[braced ?? plain ?? ""];
    if (value === undefined || hasControlCharacters(value)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
    return value;
  });
  if (expanded.includes("$") || !path.posix.isAbsolute(expanded)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  const canonicalCandidate = path.posix.normalize(expanded);

  return canonicalCandidate;
}


/**
 * Формирует argv для installed Hermes и регистрирует Ebb MCP только в памяти процесса.
 * Повторно проверяет exact HEAD и clean status до первого Hermes import и последующих
 * source imports. Предусловие Plan20: pinned source не обновляют от финальной проверки
 * перед импортом до завершения Run; verifier не удерживает внешние writers.
 */
export function buildHermesInstalledRuntimeArgs(input: {
  readonly hermesProjectRoot: string;
  readonly sourceCommit: string;
  readonly runtimeExecutablePath: string;
  readonly hermesHome: string;
  readonly mcpServer?: { readonly command: string; readonly args: readonly string[] };
}): readonly string[] {
  const paths = path.win32.isAbsolute(input.hermesProjectRoot) ? path.win32 : path.posix;
  if (!paths.isAbsolute(input.hermesProjectRoot) || !paths.isAbsolute(input.runtimeExecutablePath) ||
      !paths.isAbsolute(input.hermesHome) || hasControlCharacters(input.hermesProjectRoot) ||
      hasControlCharacters(input.runtimeExecutablePath) || hasControlCharacters(input.hermesHome) ||
      !/^[a-f0-9]{40}$/u.test(input.sourceCommit)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const sourceRoot = pythonUnicodeEscape(input.hermesProjectRoot);
  const expectedSourceCommit = pythonUnicodeEscape(input.sourceCommit);
  const sourceVerifier =
    "import subprocess,threading\n" +
    `ebb_hermes_source_root = ${sourceRoot}\n` +
    `ebb_hermes_source_commit = ${expectedSourceCommit}\n` +
    "def ebb_verify_hermes_source():\n" +
    "    try:\n" +
    "        def git(args):\n" +
    "            env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}\n" +
    "            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)\n" +
    "            command = ['git', '--no-optional-locks', '--no-replace-objects', '-c', 'core.excludesFile=', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.ignoreStat=false', '-C', ebb_hermes_source_root, *args]\n" +
    "            child = subprocess.Popen(command, cwd=ebb_hermes_source_root, env=env, shell=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)\n" +
    "            output = []\n" +
    "            def read_output():\n" +
    "                try:\n" +
    "                    output.append(child.stdout.read(8193))\n" +
    "                except Exception:\n" +
    "                    pass\n" +
    "            reader = threading.Thread(target=read_output, daemon=True)\n" +
    "            try:\n" +
    "                reader.start()\n" +
    "                reader.join(timeout=5)\n" +
    "                if reader.is_alive() or not output or len(output[0]) > 8192:\n" +
    "                    raise RuntimeError('source metadata unavailable')\n" +
    "                if child.wait(timeout=1) != 0:\n" +
    "                    raise RuntimeError('git failed')\n" +
    "                return output[0].decode('utf-8', errors='strict').strip()\n" +
    "            finally:\n" +
    "                if child.poll() is None:\n" +
    "                    child.kill()\n" +
    "                    try:\n" +
    "                        child.wait(timeout=1)\n" +
    "                    except subprocess.TimeoutExpired:\n" +
    "                        pass\n" +
    "                if not reader.is_alive():\n" +
    "                    child.stdout.close()\n" +
    "        root = os.path.normcase(os.path.realpath(ebb_hermes_source_root))\n" +
    "        git_root = os.path.normcase(os.path.realpath(git(['rev-parse', '--show-toplevel'])))\n" +
    "        if root != git_root:\n" +
    "            raise RuntimeError('source root mismatch')\n" +
    "        if git(['rev-parse', '--verify', 'HEAD^{commit}']) != ebb_hermes_source_commit:\n" +
    "            raise SystemExit('HERMES_SOURCE_IDENTITY_MISMATCH')\n" +
    "        if git(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames']):\n" +
    "            raise SystemExit('HERMES_SOURCE_IDENTITY_DIRTY')\n" +
    "    except SystemExit:\n" +
    "        raise\n" +
    "    except Exception:\n" +
    "        raise SystemExit('HERMES_SOURCE_IDENTITY_UNAVAILABLE')\n";
  const registration = input.mcpServer
    ? "import json\n" +
      "from tools.mcp_tool_discovery import register_mcp_servers\n" +
      `ebb_mcp = json.loads(${pythonUnicodeEscape(JSON.stringify({ "ebb-orchestrator": {
        command: input.mcpServer.command, args: input.mcpServer.args,
        trust: "full", lazy: false, tools: { resources: false, prompts: false },
      } }))})\n` +
      "if 'mcp__ebb_orchestrator__submit_result' not in register_mcp_servers(ebb_mcp):\n" +
      "    raise SystemExit('HERMES_EBB_MCP_REGISTRATION_FAILED')\n"
    : "";
  const bootstrap =
    "import os,sys,runpy\n" +
    "os.environ.pop('PYTHONHOME', None)\n" +
    "os.environ.pop('PYTHONPATH', None)\n" +
    "os.environ.pop('VIRTUAL_ENV', None)\n" +
    `os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or ${pythonUnicodeEscape(input.hermesHome)}\n` +
    "sys.dont_write_bytecode = True\n" +
    sourceVerifier +
    `sys.path.insert(0, ${sourceRoot})\n` +
    "ebb_verify_hermes_source()\n" +
    "import hermes_bootstrap\n" +
    "ebb_verify_hermes_source()\n" +
    registration +
    "ebb_verify_hermes_source()\n" +
    "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)\n";
  return Object.freeze(["-I", "-B", "-c", bootstrap]);
}

function pythonUnicodeEscape(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === "\\") escaped += "\\\\";
    else if (character === "'") escaped += "\\x27";
    else if (character === '"') escaped += "\\x22";
    else if (code <= 0x7e && code >= 0x20) escaped += character;
    else if (code <= 0xffff) escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `'${escaped}'`;
}
