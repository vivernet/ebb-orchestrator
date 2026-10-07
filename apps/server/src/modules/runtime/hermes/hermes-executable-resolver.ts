import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "./hermes-provider-selection.js";
import type { HermesLaunchObjectIdentity, HermesWindowsPathIdentityChain } from "./hermes-launch-ticket.js";
import { isVerifiedHermesSourceSnapshot, type HermesSourceSnapshot } from "./hermes-source-snapshot.js";
import { ProcessExecutor, type ProcessOptions, type ProcessResult } from "../../../platform/process/process-executor.js";
import { verifyNativeHelperIntegrity } from "../../../platform/process/native-helper-integrity.js";
import { runVerifiedNativeHelper } from "../../../platform/process/native-helper-launcher.js";

const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 8_192;
const INSTALL_STAMP_MAX_BYTES = 2_048;
const MAX_LAUNCHER_BYTES = 2 * 1024 * 1024;
const MAX_LAUNCHER_SCRIPT_BYTES = 64 * 1024;
const MAX_SIDECAR_BYTES = 96 * 1024;
const TRUSTED_GIT_SIGNER_SUBJECT = "CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE";
const TRUSTED_GIT_SIGNER_THUMBPRINT = "3EB14A3AEF84B7153E139397F0A49E2FAC662B0E";
const PATH_VERIFIER_TIMEOUT_MS = 5_000;
const PATH_VERIFIER_MAX_BUFFER = 1_024;
const PATH_CHAIN_VERIFIER_MAX_BUFFER = 8_192;

interface WindowsNativeSafePathIdentity {
  readonly platform: "win32";
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly volumeSerial: string;
  readonly fileId: string;
}

interface LinuxNativeSafePathIdentity {
  readonly platform: "linux";
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

type NativeSafePathIdentity = WindowsNativeSafePathIdentity | LinuxNativeSafePathIdentity;

interface PathIdentityGuard {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface HermesExecutableResolution {
  /** Absolute Hermes launcher path resolved from the trusted install. */
  readonly executablePath: string;
  readonly executableIdentity: HermesLaunchObjectIdentity;
  /** Windows Hermes is a distlib shim; this is the image actually created by the Job helper. */
  readonly runtimeExecutablePath: string;
  readonly runtimeExecutableIdentity: HermesLaunchObjectIdentity;
  /** Verified root of the pinned Python runtime used to resolve ordinary dependencies. */
  readonly runtimeDependencyRoot: string;
  readonly runtimeArgsPrefix: readonly string[];
  readonly hermesProjectRoot: string;
  /** Canonical native auth/config root paired with the resolved pinned Hermes installation. */
  readonly hermesConfigHome: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  /** Exact Git tree object for the verified pinned source commit. */
  readonly sourceTree: string;
  /** Absolute Git executable whose identity and pinned source evidence were verified. */
  readonly gitExecutable: string;
}

export interface HermesResolverCommandOptions extends ProcessOptions {
  readonly shell: false;
}

export interface HermesExecutableResolverOptions {
  /** Рабочая директория вызывающего Orchestrator; локальный launcher внутри неё не считается доверенным. */
  readonly cwd?: string;
  /** PATH из доверенного окружения процесса Orchestrator, без наследования остальных переменных. */
  readonly pathValue?: string;
  readonly platform?: "win32" | "linux";
  /** Snapshot only for non-secret Hermes home/runtime path variables; defaults to process.env. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Узкий seam для тестов; production использует ProcessExecutor с shell:false. */
  readonly runCommand?: (
    file: string,
    args: string[],
    options: HermesResolverCommandOptions,
  ) => Promise<ProcessResult>;
  /** Отдельный test seam для path verifier; production по умолчанию запускает integrity-checked native helper. */
  readonly runNativePathVerifier?: (
    file: string,
    args: string[],
    options: HermesResolverCommandOptions,
  ) => Promise<ProcessResult>;
  /** Узкий seam для тестов; production проверяет helper по parent-code SHA anchor. */
  readonly verifyNativeHelper?: typeof verifyNativeHelperIntegrity;
}

/**
 * Разрешает единственный Hermes launcher из абсолютных PATH entries и связывает его с точной
 * закреплённой исходной установкой через launcher/Git identity и Git state. Hermes Python
 * bootstrap здесь не запускается: его модули доступны только после публикации проверенного snapshot.
 *
 * Запускаются только launcher и Git с `shell:false`, фиксированным timeout и малым буфером.
 * В дочернее окружение передаётся только отфильтрованный PATH и системные переменные ОС; Hermes
 * config, profile, provider credentials и auth не читаются и не наследуются. Любая неоднозначность,
 * неподдерживаемая форма bootstrap или неполное доказательство source pin приводит к отказу.
 *
 * @param options PATH, cwd и тестовый process seam; значения не принимаются из Hermes stdout.
 * @returns Абсолютные пути launcher/source root и версия/commit, соответствующие source pin.
 * @throws {Error} С фиксированным кодом причины при неоднозначности или недостаточном evidence.
 */
export async function resolveHermesExecutable(
  options: HermesExecutableResolverOptions = {},
): Promise<HermesExecutableResolution> {
  const platform = options.platform ?? currentPlatform();
  if (platform === "linux") return resolveLinuxHermesExecutable(options);
  if (platform !== "win32") throw resolverError("HERMES_PLATFORM_UNSUPPORTED_PROVENANCE");
  const paths = platformPaths(platform);
  const cwd = await canonicalExistingDirectory(options.cwd ?? process.cwd(), paths);
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const pathEntries = await resolvePathEntries(pathValue, cwd, paths);
  const executablePath = await resolveUniqueHermesLauncher(pathEntries, cwd, paths);
  const layout = await resolveWindowsInstallLayout(executablePath, cwd);
  const runCommand = options.runCommand ?? createProcessRunner();
  const runPathVerifier = options.runNativePathVerifier ?? createNativePathVerifierRunner();
  const pathVerifier = bundledPathVerifierPath(platform);
  await (options.verifyNativeHelper ?? verifyNativeHelperIntegrity)(pathVerifier, "hermesProfilePath");
  const identities = new Map<string, NativeSafePathIdentity>();
  let trustedWindowsPowerShellPath: string | undefined;
  const verifyAndRemember = async (value: string, kind: "file" | "directory"): Promise<NativeSafePathIdentity> => {
    const identity = kind === "file" && trustedWindowsPowerShellPath &&
      samePath(value, trustedWindowsPowerShellPath, "win32")
      ? await verifyNativeWindowsSystemPowerShell(pathVerifier, cwd, runPathVerifier)
      : samePath(value, layout.hermesHome, "win32")
        ? await verifyNativeSafePath(pathVerifier, value, kind, cwd, runPathVerifier)
        : isWithin(layout.hermesHome, value, paths)
          ? await verifyWindowsHermesInstallPath(pathVerifier, value, kind, layout.hermesHome, runPathVerifier)
          : await verifyNativeSafePath(pathVerifier, value, kind, cwd, runPathVerifier);
    const key = `${kind}:${value.toLowerCase()}`;
    const known = identities.get(key);
    if (known && !sameNativeIdentity(known, identity)) throw resolverError("HERMES_PATH_IDENTITY_CHANGED");
    if (!known) identities.set(key, identity);
    return identity;
  };
  const assertIdentityGuards = async (guards: readonly PathIdentityGuard[]): Promise<void> => {
    for (const guard of guards) await verifyAndRemember(guard.path, guard.kind);
  };
  const trustedWindowsPowerShell = await verifyNativeWindowsSystemPowerShell(pathVerifier, cwd, runPathVerifier);
  trustedWindowsPowerShellPath = trustedWindowsPowerShell.path;
  identities.set(`file:${trustedWindowsPowerShellPath.toLowerCase()}`, trustedWindowsPowerShell);

  const executableIdentity = await verifyAndRemember(executablePath, "file");
  if (executableIdentity.platform !== "win32") throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  await verifyAndRemember(layout.hermesProjectRoot, "directory");
  const executableBytes = await readBoundedFile(executablePath, MAX_LAUNCHER_BYTES, "HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const launcher = inspectPinnedWindowsLauncher(executableBytes, layout.hermesProjectRoot);
  const pythonPath = await canonicalExistingFile(launcher.pythonExecutable, paths);
  if (!isWithin(paths.join(layout.hermesHome, "tools"), pythonPath, paths)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const runtimeExecutableIdentity = await verifyAndRemember(pythonPath, "file");
  if (runtimeExecutableIdentity.platform !== "win32") throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  const runtimeDependencyRoot = await canonicalExistingDirectory(paths.dirname(pythonPath), paths);
  if (!isWithin(paths.join(layout.hermesHome, "tools"), runtimeDependencyRoot, paths) ||
      isWithin(layout.hermesProjectRoot, runtimeDependencyRoot, paths) ||
      isWithin(runtimeDependencyRoot, layout.hermesProjectRoot, paths)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  await verifyAndRemember(runtimeDependencyRoot, "directory");
  await verifyWindowsCommandSidecar(paths.join(paths.dirname(executablePath), "hermes.cmd"), pythonPath, launcher.scriptBytes);
  const git = await resolveTrustedWindowsGit(
    pathEntries, runCommand, verifyAndRemember, assertIdentityGuards, trustedWindowsPowerShellPath,
  );
  const gitPath = git.path;
  const env = buildProbeEnvironment([paths.dirname(gitPath), paths.dirname(pythonPath)], platform);

  await verifyInstallStamp(layout.hermesProjectRoot);
  const gitRunner = createGuardedRunner(runCommand, assertIdentityGuards, [
    { path: gitPath, kind: "file" },
    { path: layout.hermesProjectRoot, kind: "directory" },
  ]);
  const sourceTree = await verifyPinnedGitSource(layout.hermesProjectRoot, cwd, env, platform, gitPath, gitRunner);

  return Object.freeze({
    executablePath,
    executableIdentity: Object.freeze({
      platform: "win32",
      volumeSerial: executableIdentity.volumeSerial,
      fileId: executableIdentity.fileId,
    }),
    runtimeExecutablePath: pythonPath,
    runtimeExecutableIdentity: Object.freeze({
      platform: "win32",
      volumeSerial: runtimeExecutableIdentity.volumeSerial,
      fileId: runtimeExecutableIdentity.fileId,
    }),
    runtimeDependencyRoot,
    runtimeArgsPrefix: failClosedRuntimeArgsPrefix(),
    hermesProjectRoot: layout.hermesProjectRoot,
    hermesConfigHome: layout.hermesHome,
    sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
    sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    sourceTree,
    gitExecutable: gitPath,
  });
}

async function resolveLinuxHermesExecutable(
  options: HermesExecutableResolverOptions,
): Promise<HermesExecutableResolution> {
  const platform = "linux" as const;
  const paths = path.posix;
  const environment = options.environment ?? process.env;
  const cwd = await canonicalExistingDirectory(options.cwd ?? process.cwd(), paths);
  const pathValue = options.pathValue ?? environment.PATH ?? "";
  const pathEntries = await resolvePathEntries(pathValue, cwd, paths);
  const executablePath = await resolveUniqueLinuxHermesLauncher(pathEntries, cwd);
  const runCommand = options.runCommand ?? createProcessRunner();
  const runPathVerifier = options.runNativePathVerifier ?? createNativePathVerifierRunner();
  const pathVerifier = bundledPathVerifierPath(platform);
  await (options.verifyNativeHelper ?? verifyNativeHelperIntegrity)(pathVerifier, "hermesProfilePath");
  const identities = new Map<string, NativeSafePathIdentity>();
  const verifyAndRemember = async (value: string, kind: "file" | "directory"): Promise<LinuxNativeSafePathIdentity> => {
    const identity = await verifyNativeSafePath(pathVerifier, value, kind, cwd, runPathVerifier, platform);
    if (identity.platform !== platform) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    const key = `${kind}:${value}`;
    const known = identities.get(key);
    if (known && !sameNativeIdentity(known, identity)) throw resolverError("HERMES_PATH_IDENTITY_CHANGED");
    if (!known) identities.set(key, identity);
    return identity;
  };
  const assertIdentityGuards = async (guards: readonly PathIdentityGuard[]): Promise<void> => {
    for (const guard of guards) await verifyAndRemember(guard.path, guard.kind);
  };

  const executableIdentity = await verifyAndRemember(executablePath, "file");
  const layout = await resolveLinuxInstallLayout(executablePath);
  if (isWithin(cwd, layout.hermesProjectRoot, paths)) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  const innerLauncherIdentity = samePath(layout.innerLauncherPath, executablePath, platform)
    ? executableIdentity
    : await verifyAndRemember(layout.innerLauncherPath, "file");
  const sourceIdentity = await verifyAndRemember(layout.hermesProjectRoot, "directory");
  const configHomeInput = resolveLinuxHermesConfigHome(environment);
  const hermesConfigHome = await canonicalExistingDirectory(configHomeInput, paths);
  if (!samePath(configHomeInput, hermesConfigHome, platform)) throw resolverError("HERMES_CONFIG_HOME_UNSAFE");
  await verifyAndRemember(hermesConfigHome, "directory");

  const stamp = await verifyInstallStamp(layout.hermesProjectRoot, platform);
  const hermesRuntime = await resolveLinuxHermesPythonPath(hermesConfigHome, environment, stamp);
  if (!samePath(hermesRuntime.runtimeRootInput, hermesRuntime.runtimeRoot, platform)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  await verifyAndRemember(hermesRuntime.runtimeRoot, "directory");
  await verifyAndRemember(hermesRuntime.factsPath, "file");
  const runtimeExecutablePath = await canonicalExistingFile(hermesRuntime.pythonExecutable, paths);
  if (!isWithin(hermesRuntime.pythonEntryRoot, runtimeExecutablePath, paths) ||
      !(await access(runtimeExecutablePath, fsConstants.X_OK).then(() => true, () => false))) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const runtimeExecutableIdentity = await verifyAndRemember(runtimeExecutablePath, "file");
  const runtimeDependencyRoot = await canonicalExistingDirectory(hermesRuntime.pythonEntryRoot, paths);
  if (!samePath(runtimeDependencyRoot, hermesRuntime.pythonEntryRoot, platform) ||
      !isWithin(hermesRuntime.runtimeRoot, runtimeDependencyRoot, paths) ||
      isWithin(layout.hermesProjectRoot, runtimeDependencyRoot, paths) ||
      isWithin(runtimeDependencyRoot, layout.hermesProjectRoot, paths)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  await verifyAndRemember(runtimeDependencyRoot, "directory");
  const launcherBytes = await readBoundedPosixFile(
    layout.innerLauncherPath, MAX_LAUNCHER_SCRIPT_BYTES, "HERMES_LAUNCHER_PROVENANCE_MISMATCH",
  );
  const expectedLauncher = pinnedLinuxShellLauncher(hermesRuntime.pythonExecutable, layout.hermesProjectRoot);
  if (!launcherBytes.equals(Buffer.from(expectedLauncher, "utf8"))) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }

  const gitPath = await canonicalExistingFile("/usr/bin/git", paths).catch(() => {
    throw resolverError("HERMES_GIT_TRUST_UNAVAILABLE");
  });
  if (!samePath(gitPath, "/usr/bin/git", platform) ||
      !(await access(gitPath, fsConstants.X_OK).then(() => true, () => false))) {
    throw resolverError("HERMES_GIT_TRUST_UNAVAILABLE");
  }
  const gitIdentity = await verifyAndRemember(gitPath, "file");
  const env = buildProbeEnvironment(["/usr/bin", paths.dirname(runtimeExecutablePath)], platform);
  env.HERMES_HOME = hermesConfigHome;
  if (environment.HERMES_RUNTIME_DIR?.trim()) env.HERMES_RUNTIME_DIR = hermesRuntime.runtimeRoot;
  if (environment.HERMES_DATA_DIR_SUFFIX !== undefined) env.HERMES_DATA_DIR_SUFFIX = environment.HERMES_DATA_DIR_SUFFIX;

  const gitRunner = createGuardedRunner(runCommand, assertIdentityGuards, [
    { path: gitPath, kind: "file" },
    { path: layout.hermesProjectRoot, kind: "directory" },
  ]);
  const sourceTree = await verifyPinnedGitSource(layout.hermesProjectRoot, cwd, env, platform, gitPath, gitRunner);

  // The process-scope launcher reopens both the Hermes PATH identity and exact Python image by fd.
  void innerLauncherIdentity;
  void sourceIdentity;
  void gitIdentity;
  return Object.freeze({
    executablePath,
    executableIdentity: Object.freeze({ platform, device: executableIdentity.device, inode: executableIdentity.inode }),
    runtimeExecutablePath,
    runtimeExecutableIdentity: Object.freeze({ platform, device: runtimeExecutableIdentity.device, inode: runtimeExecutableIdentity.inode }),
    runtimeDependencyRoot,
    runtimeArgsPrefix: failClosedRuntimeArgsPrefix(),
    hermesProjectRoot: layout.hermesProjectRoot,
    hermesConfigHome,
    sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
    sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    sourceTree,
    gitExecutable: gitPath,
  });
}

/** Применяет только path-resolution правила pinned Hermes для Linux HERMES_HOME. */
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
  const parent = path.posix.dirname(canonicalCandidate);
  // Hermes maps only a direct `<root>/profiles/<profile>` override back to `<root>`.
  // Other nested HERMES_HOME values are independent roots, even under the default `.hermes` path.
  return path.posix.basename(parent) === "profiles" ? path.posix.dirname(parent) : canonicalCandidate;
}

async function resolveLinuxHermesPythonPath(
  hermesConfigHome: string,
  environment: Readonly<Record<string, string | undefined>>,
  stamp: Readonly<Record<string, unknown>>,
): Promise<{
  runtimeRootInput: string;
  runtimeRoot: string;
  factsPath: string;
  pythonExecutable: string;
  pythonEntryRoot: string;
}> {
  const paths = path.posix;
  const override = environment.HERMES_RUNTIME_DIR?.trim();
  const stampedRuntime = typeof stamp.runtimeDir === "string" ? stamp.runtimeDir : "";
  const runtimeRootInput = override || stampedRuntime || paths.join(hermesConfigHome, "tools");
  if (!paths.isAbsolute(runtimeRootInput) || hasControlCharacters(runtimeRootInput)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const runtimeRoot = await canonicalExistingDirectory(runtimeRootInput, paths).catch(() => {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  });
  const factsPath = paths.join(runtimeRoot, "facts.json");
  const factsBytes = await readBoundedPosixFile(factsPath, 1024 * 1024, "HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  let facts: unknown;
  try {
    facts = JSON.parse(factsBytes.toString("utf8")) as unknown;
  } catch {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  if (typeof facts !== "object" || facts === null || Array.isArray(facts) ||
      (facts as Record<string, unknown>).schema !== 1 ||
      typeof (facts as Record<string, unknown>).packages !== "object" || (facts as Record<string, unknown>).packages === null) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const packages = (facts as { packages: Record<string, unknown> }).packages;
  const pythonFacts = packages.python;
  if (typeof pythonFacts !== "object" || pythonFacts === null || Array.isArray(pythonFacts) ||
      typeof (pythonFacts as Record<string, unknown>).entry !== "string") {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const entry = (pythonFacts as { entry: string }).entry;
  const components = entry.split("/");
  if (!entry || entry.length > 512 || components.some((component) => !component || component === "." || component === "..") ||
      paths.isAbsolute(entry) || hasControlCharacters(entry)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  const pythonEntryRoot = paths.join(runtimeRoot, entry);
  const pythonExecutable = paths.join(pythonEntryRoot, "bin", "python3");
  if (!isWithin(runtimeRoot, pythonEntryRoot, paths) || !isWithin(runtimeRoot, pythonExecutable, paths)) {
    throw resolverError("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
  }
  return { runtimeRootInput, runtimeRoot, factsPath, pythonExecutable, pythonEntryRoot };
}

async function resolveLinuxInstallLayout(executablePath: string): Promise<{
  hermesProjectRoot: string;
  innerLauncherPath: string;
}> {
  const paths = path.posix;
  const candidate = await canonicalExistingFile(executablePath, paths).catch(() => {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  });
  const candidateBytes = await readBoundedPosixFile(candidate, MAX_LAUNCHER_BYTES, "HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  let innerLauncherPath = candidate;
  if (!candidate.endsWith("/.hermes/bin/hermes")) {
    const command = parsePosixShellLauncher(candidateBytes.toString("utf8"));
    if (command.length !== 1) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
    innerLauncherPath = command[0]!;
  }
  if (!paths.isAbsolute(innerLauncherPath) || !innerLauncherPath.endsWith("/.hermes/bin/hermes") ||
      hasControlCharacters(innerLauncherPath)) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  const canonicalInner = await canonicalExistingFile(innerLauncherPath, paths).catch(() => {
    throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  });
  if (!samePath(canonicalInner, innerLauncherPath, "linux")) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  const hermesProjectRoot = paths.dirname(paths.dirname(paths.dirname(innerLauncherPath)));
  const canonicalRoot = await canonicalExistingDirectory(hermesProjectRoot, paths).catch(() => {
    throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  });
  if (!samePath(canonicalRoot, hermesProjectRoot, "linux")) throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  return { hermesProjectRoot, innerLauncherPath };
}

async function resolveUniqueLinuxHermesLauncher(pathEntries: string[], cwd: string): Promise<string> {
  const matches = new Set<string>();
  for (const directory of pathEntries) {
    const candidate = path.posix.join(directory, "hermes");
    const details = await lstat(candidate).catch(() => undefined);
    if (!details?.isFile() || details.isSymbolicLink()) continue;
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical || !path.posix.isAbsolute(canonical) || !samePath(candidate, canonical, "linux") || isWithin(cwd, canonical, path.posix)) continue;
    if (!(await access(canonical, fsConstants.X_OK).then(() => true, () => false))) continue;
    matches.add(canonical);
  }
  if (matches.size === 0) throw resolverError("HERMES_LAUNCHER_NOT_FOUND");
  if (matches.size !== 1) throw resolverError("HERMES_LAUNCHER_AMBIGUOUS");
  return [...matches][0]!;
}

function parsePosixShellLauncher(content: string): string[] {
  const match = /^#!\/bin\/sh\nexec (.+) "\$@"\n$/u.exec(content);
  if (!match) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  return parseCanonicalPosixShellWords(match[1]!);
}

function parseCanonicalPosixShellWords(encoded: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < encoded.length) {
    while (encoded[index] === " ") index += 1;
    if (index >= encoded.length) break;
    let word = "";
    let state: "plain" | "single" | "double" = "plain";
    let started = false;
    while (index < encoded.length) {
      const character = encoded[index]!;
      if (state === "plain") {
        if (character === " ") break;
        if (character === "'") state = "single";
        else if (character === '"') state = "double";
        else if (/^[A-Za-z0-9_@%+=:,./-]$/u.test(character)) word += character;
        else throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
        started = true;
      } else if (state === "single") {
        if (character === "'") state = "plain";
        else word += character;
      } else if (character === '"') {
        state = "plain";
      } else {
        word += character;
      }
      index += 1;
    }
    if (!started || state !== "plain") throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
    words.push(word);
  }
  if (words.length === 0 || posixShellJoin(words) !== encoded) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  return words;
}

function posixShellJoin(words: readonly string[]): string {
  return words.map((value) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`).join(" ");
}

function pinnedLinuxShellLauncher(pythonPath: string, sourceRoot: string): string {
  const script = pinnedLinuxLauncherScript(sourceRoot);
  return `#!/bin/sh\nexec ${posixShellJoin([pythonPath, "-I", "-c", script])} "$@"\n`;
}

/** Строит только pinned Hermes source launcher bootstrap для Linux; путь/содержимое не приходит из shell wrapper. */
export function pinnedLinuxLauncherScript(sourceRoot: string): string {
  if (!path.posix.isAbsolute(sourceRoot) || hasControlCharacters(sourceRoot)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const literal = pythonRepr(sourceRoot);
  return "import os, re, sys\n" +
    "os.environ.pop('PYTHONHOME', None)\n" +
    "os.environ.pop('PYTHONPATH', None)\n" +
    `sys.path.insert(0, ${literal})\n` +
    "from hermes_constants import get_default_hermes_root\n" +
    "os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(get_default_hermes_root())\n" +
    "import hermes_bootstrap\n" +
    "if sys.argv[1:2] == ['--run-module']:\n" +
    "    import runpy\n" +
    "    if len(sys.argv) < 3: sys.exit('hermes: --run-module needs a module')\n" +
    "    module = sys.argv.pop(2)\n" +
    "    del sys.argv[1]\n" +
    "    runpy.run_module(module, run_name='__main__', alter_sys=True)\n" +
    "    sys.exit(0)\n" +
    "from hermes_cli.main import main\n" +
    "sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n" +
    "sys.exit(main())\n";
}

async function readBoundedPosixFile(pathname: string, maxBytes: number, errorCode: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(pathname, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    const currentUser = BigInt(process.geteuid?.() ?? -1);
    if (!before.isFile() || before.size > BigInt(maxBytes) ||
        (before.uid !== currentUser && before.uid !== 0n) || (before.mode & 0o022n) !== 0n) {
      throw resolverError(errorCode);
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (contents.byteLength > maxBytes || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw resolverError(errorCode);
    }
    return contents;
  } catch {
    throw resolverError(errorCode);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Повторно проверяет OS-handle identity точного Run profile перед выдачей launch ticket. */
export async function verifyHermesProfileHomeIdentity(profileHome: string): Promise<HermesLaunchObjectIdentity> {
  const platform = currentPlatform();
  const paths = platformPaths(platform);
  const helperPath = bundledPathVerifierPath(platform);
  await verifyNativeHelperIntegrity(helperPath, "hermesProfilePath");
  const canonical = await canonicalExistingDirectory(profileHome, paths);
  const identity = await verifyNativeSafePath(
    helperPath, canonical, "directory", process.cwd(), createNativePathVerifierRunner(), platform,
  );
  if (identity.platform === "linux") {
    return Object.freeze({ platform: "linux", device: identity.device, inode: identity.inode });
  }
  return Object.freeze({ platform: "win32", volumeSerial: identity.volumeSerial, fileId: identity.fileId });
}

/** Фиксирует приватные native identity точных `home` и `config.yaml` после их создания для Windows Run. */
export async function verifyHermesRunProfileTargetIdentities(profileHome: string): Promise<{
  readonly home: HermesLaunchObjectIdentity;
  readonly config: HermesLaunchObjectIdentity;
}> {
  if (currentPlatform() !== "win32" || !path.win32.isAbsolute(profileHome) || hasControlCharacters(profileHome)) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const canonicalProfile = await canonicalExistingDirectory(profileHome, path.win32);
  const expectedHome = path.win32.join(canonicalProfile, "home");
  const expectedConfig = path.win32.join(canonicalProfile, "config.yaml");
  const helperPath = bundledPathVerifierPath("win32");
  await verifyNativeHelperIntegrity(helperPath, "hermesProfilePath");
  const runner = createNativePathVerifierRunner();
  const [home, config] = await Promise.all([
    verifyNativeSafePath(helperPath, expectedHome, "directory", process.cwd(), runner, "win32"),
    verifyNativeSafePath(helperPath, expectedConfig, "file", process.cwd(), runner, "win32"),
  ]);
  if (home.platform !== "win32" || config.platform !== "win32") throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  return Object.freeze({
    home: Object.freeze({ platform: "win32", volumeSerial: home.volumeSerial, fileId: home.fileId }),
    config: Object.freeze({ platform: "win32", volumeSerial: config.volumeSerial, fileId: config.fileId }),
  });
}

/** Повторно фиксирует все native directory identities от volume root до точного Run profile на Windows. */
export async function verifyHermesProfileHomePathChain(
  profileHome: string,
  authRoot: string,
): Promise<HermesWindowsPathIdentityChain | undefined> {
  if (currentPlatform() !== "win32") return undefined;
  const paths = path.win32;
  if (!paths.isAbsolute(profileHome) || !paths.isAbsolute(authRoot) || hasControlCharacters(profileHome) ||
      hasControlCharacters(authRoot)) throw resolverError("HERMES_PATH_UNSAFE");
  const helperPath = bundledPathVerifierPath("win32");
  await verifyNativeHelperIntegrity(helperPath, "hermesProfilePath");
  const canonicalProfileHome = await canonicalExistingDirectory(profileHome, paths);
  const canonicalAuthRoot = await canonicalExistingDirectory(authRoot, paths);
  let result: ProcessResult;
  try {
    result = await createNativePathVerifierRunner()(helperPath, [
      "verify-safe-path-chain", "directory", canonicalProfileHome, canonicalAuthRoot,
    ], {
      shell: false,
      cwd: process.cwd(),
      env: (() => {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
        return systemRoot
          ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: paths.join(systemRoot, "System32") }
          : {};
      })(),
      timeout: PATH_VERIFIER_TIMEOUT_MS,
      maxBuffer: PATH_CHAIN_VERIFIER_MAX_BUFFER,
    });
  } catch (error) {
    throw nativePathVerifierFailure(error);
  }
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > PATH_CHAIN_VERIFIER_MAX_BUFFER) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const line = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2) :
    result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  return parseNativeSafePathIdentityChain(line, canonicalProfileHome, canonicalAuthRoot, "win32");
}

function currentPlatform(): "win32" | "linux" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  throw resolverError("HERMES_PLATFORM_UNSUPPORTED");
}

type PlatformPaths = typeof path.win32 | typeof path.posix;

function platformPaths(platform: "win32" | "linux"): PlatformPaths {
  return platform === "win32" ? path.win32 : path.posix;
}

async function resolveWindowsInstallLayout(
  executablePath: string,
  cwd: string,
): Promise<{ hermesHome: string; hermesProjectRoot: string }> {
  const home = path.win32.dirname(path.win32.dirname(executablePath));
  if (path.win32.basename(path.win32.dirname(executablePath)).toLowerCase() !== "bin" ||
      !samePath(path.win32.join(home, "bin", "hermes.exe"), executablePath, "win32")) {
    throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  }
  const hermesHome = await canonicalExistingDirectory(home, path.win32);
  const hermesProjectRoot = await canonicalExistingDirectory(path.win32.join(hermesHome, "hermes-agent"), path.win32)
    .catch(() => { throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED"); });
  if (isWithin(cwd, hermesProjectRoot, path.win32) || !samePath(path.win32.dirname(hermesProjectRoot), hermesHome, "win32")) {
    throw resolverError("HERMES_INSTALL_LAYOUT_UNSUPPORTED");
  }
  return { hermesHome, hermesProjectRoot };
}

async function canonicalExistingFile(value: string, paths: PlatformPaths): Promise<string> {
  if (!paths.isAbsolute(value) || hasControlCharacters(value)) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const linkDetails = await lstat(value).catch(() => { throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH"); });
  if (!linkDetails.isFile() || linkDetails.isSymbolicLink()) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const canonical = await realpath(value).catch(() => { throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH"); });
  const details = await stat(canonical).catch(() => { throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH"); });
  if (!details.isFile()) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  return canonical;
}

async function readBoundedFile(pathname: string, maxBytes: number, errorCode: string): Promise<Buffer> {
  const details = await lstat(pathname).catch(() => { throw resolverError(errorCode); });
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) throw resolverError(errorCode);
  return readFile(pathname).catch(() => { throw resolverError(errorCode); });
}

function bundledPathVerifierPath(platform: "win32" | "linux"): string {
  const filename = platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path";
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../dist/native/hermes-profile-path", filename);
}

async function verifyNativeSafePath(
  verifierPath: string,
  value: string,
  kind: "file" | "directory",
  cwd: string,
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
  platform: "win32" | "linux" = "win32",
): Promise<NativeSafePathIdentity> {
  const paths = platformPaths(platform);
  if (!paths.isAbsolute(value) || hasControlCharacters(value)) throw resolverError("HERMES_PATH_UNSAFE");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  let result: ProcessResult;
  try {
    result = await runner(verifierPath, ["verify-safe-path", kind, value], {
      shell: false,
      cwd,
      env: platform === "win32"
        ? { ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.win32.join(systemRoot, "System32") } : {}) }
        : { PATH: "/usr/bin:/bin" },
      timeout: PATH_VERIFIER_TIMEOUT_MS,
      maxBuffer: PATH_VERIFIER_MAX_BUFFER,
    });
  } catch (error) {
    throw nativePathVerifierFailure(error);
  }
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > PATH_VERIFIER_MAX_BUFFER) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const line = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2) :
    result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return parseNativeSafePathIdentity(line, kind, value, await realpath(value).catch(() => {
    throw resolverError("HERMES_PATH_UNSAFE");
  }), platform);
}

/** Проверяет PowerShell через OS-derived native path; TrustedInstaller разрешён только в этом dependency chain. */
async function verifyNativeWindowsSystemPowerShell(
  verifierPath: string,
  cwd: string,
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
): Promise<WindowsNativeSafePathIdentity> {
  let result: ProcessResult;
  try {
    result = await runner(verifierPath, ["verify-windows-system-powershell"], {
      shell: false,
      cwd,
      timeout: PATH_VERIFIER_TIMEOUT_MS,
      maxBuffer: PATH_VERIFIER_MAX_BUFFER,
    });
  } catch (error) {
    throw nativePathVerifierFailure(error);
  }
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > PATH_VERIFIER_MAX_BUFFER) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const line = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2) :
    result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const reported = parsed as Record<string, unknown>;
  if (Object.keys(reported).sort().join(",") !== "fileId,kind,path,status,volumeSerial" ||
      reported.status !== "SAFE_PATH" || reported.kind !== "file" || typeof reported.path !== "string" ||
      !path.win32.isAbsolute(reported.path) || !reported.path.replace(/^\\\\\?\\/u, "")
        .toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe") ||
      typeof reported.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(reported.volumeSerial) ||
      typeof reported.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(reported.fileId)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const reportedPath = reported.path.startsWith("\\\\?\\") ? reported.path.slice(4) : reported.path;
  const canonicalPath = await realpath(reportedPath).catch(() => { throw resolverError("HERMES_PATH_UNSAFE"); });
  if (!samePath(reportedPath, canonicalPath, "win32")) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  const identity = parseNativeSafePathIdentity(line, "file", canonicalPath, canonicalPath, "win32");
  if (identity.platform !== "win32") throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  return Object.freeze({ ...identity, path: canonicalPath });
}

async function verifyWindowsHermesInstallPath(
  verifierPath: string,
  value: string,
  kind: "file" | "directory",
  hermesHome: string,
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
): Promise<WindowsNativeSafePathIdentity> {
  const canonicalPath = await realpath(value).catch(() => { throw resolverError("HERMES_PATH_UNSAFE"); });
  const canonicalRoot = await realpath(hermesHome).catch(() => { throw resolverError("HERMES_PATH_UNSAFE"); });
  if (!samePath(canonicalPath, value, "win32") || !samePath(canonicalRoot, hermesHome, "win32") ||
      !isWithin(canonicalRoot, canonicalPath, path.win32) || samePath(canonicalRoot, canonicalPath, "win32")) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  const args = kind === "directory"
    ? ["verify-safe-path-chain", "directory", canonicalPath, canonicalRoot]
    : ["verify-safe-file-chain", canonicalPath, canonicalRoot];
  let result: ProcessResult;
  try {
    result = await runner(verifierPath, args, {
      shell: false,
      cwd: process.cwd(),
      env: systemRoot
        ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.win32.join(systemRoot, "System32") }
        : {},
      timeout: PATH_VERIFIER_TIMEOUT_MS,
      maxBuffer: PATH_CHAIN_VERIFIER_MAX_BUFFER,
    });
  } catch (error) {
    throw nativePathVerifierFailure(error);
  }
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > PATH_CHAIN_VERIFIER_MAX_BUFFER) {
    throw resolverError("HERMES_PATH_UNSAFE");
  }
  const line = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2) :
    result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!line || line.includes("\n") || line.includes("\r")) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  if (kind === "directory") return parseNativeHermesDirectoryPathChain(line, canonicalPath, canonicalRoot);
  return parseNativeHermesFilePathChain(line, canonicalPath);
}

function parseNativeHermesDirectoryPathChain(
  line: string,
  targetPath: string,
  strictRoot: string,
): WindowsNativeSafePathIdentity {
  let parsed: unknown;
  try { parsed = JSON.parse(line) as unknown; } catch { throw resolverError("HERMES_PATH_IDENTITY_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  const result = parsed as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "profileHomePathChain,status" || result.status !== "SAFE_PATH_CHAIN" ||
      !result.profileHomePathChain || typeof result.profileHomePathChain !== "object" || Array.isArray(result.profileHomePathChain)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const chain = result.profileHomePathChain as Record<string, unknown>;
  if (Object.keys(chain).sort().join(",") !== "authRootIndex,components,version" || chain.version !== 1 ||
      !Number.isSafeInteger(chain.authRootIndex) || !Array.isArray(chain.components) || chain.components.length > 64) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const paths = path.win32;
  const normalizedTarget = paths.normalize(targetPath);
  const normalizedRoot = paths.normalize(strictRoot);
  const volumeRoot = paths.parse(normalizedTarget).root;
  const targetParts = paths.relative(volumeRoot, normalizedTarget).split(/[\\/]+/u).filter(Boolean);
  const rootParts = paths.relative(volumeRoot, normalizedRoot).split(/[\\/]+/u).filter(Boolean);
  const relativeToRoot = paths.relative(normalizedRoot, normalizedTarget);
  const expectedComponents = targetParts.length + 1;
  if (!paths.isAbsolute(normalizedTarget) || !paths.isAbsolute(normalizedRoot) || !volumeRoot ||
      !samePath(paths.resolve(normalizedTarget), normalizedTarget, "win32") ||
      !samePath(paths.resolve(normalizedRoot), normalizedRoot, "win32") ||
      relativeToRoot === "" || relativeToRoot === ".." || relativeToRoot.startsWith(`..${paths.sep}`) || paths.isAbsolute(relativeToRoot) ||
      chain.components.length !== expectedComponents || chain.authRootIndex !== rootParts.length ||
      !Number.isSafeInteger(chain.authRootIndex) || (chain.authRootIndex as number) <= 0 ||
      (chain.authRootIndex as number) >= expectedComponents) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const components = chain.components.map((component) => {
    if (!component || typeof component !== "object" || Array.isArray(component) ||
        Object.keys(component).sort().join(",") !== "fileId,volumeSerial") throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    const identity = component as Record<string, unknown>;
    if (typeof identity.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(identity.volumeSerial) ||
        typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId)) {
      throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    }
    return { volumeSerial: identity.volumeSerial, fileId: identity.fileId };
  });
  const volumeSerial = components[0]?.volumeSerial;
  const leaf = components.at(-1);
  if (!volumeSerial || !leaf || components.some((component) => component.volumeSerial !== volumeSerial)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return Object.freeze({ platform: "win32", kind: "directory", path: normalizedTarget, volumeSerial, fileId: leaf.fileId });
}

function parseNativeHermesFilePathChain(line: string, targetPath: string): WindowsNativeSafePathIdentity {
  let parsed: unknown;
  try { parsed = JSON.parse(line) as unknown; } catch { throw resolverError("HERMES_PATH_IDENTITY_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  const result = parsed as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "fileId,kind,status,volumeSerial" || result.status !== "SAFE_PATH_FILE_CHAIN" ||
      result.kind !== "file" || typeof result.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(result.volumeSerial) ||
      typeof result.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(result.fileId)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return Object.freeze({ platform: "win32", kind: "file", path: path.win32.normalize(targetPath),
    volumeSerial: result.volumeSerial, fileId: result.fileId });
}

/** Проверяет точную JSON-форму path identity, возвращаемую Windows/Linux native helper. */
export function parseNativeSafePathIdentity(
  line: string,
  kind: "file" | "directory",
  inputPath: string,
  canonicalPath: string,
  platform: "win32" | "linux",
): NativeSafePathIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const identity = parsed as Record<string, unknown>;
  if (platform === "linux") {
    const keys = Object.keys(identity).sort();
    if (keys.join(",") !== "device,inode,path,platform" || identity.platform !== "linux" ||
        typeof identity.path !== "string" || !path.posix.isAbsolute(identity.path) ||
        typeof identity.device !== "string" || !/^(0|[1-9][0-9]*)$/u.test(identity.device) ||
        typeof identity.inode !== "string" || !/^(0|[1-9][0-9]*)$/u.test(identity.inode) ||
        !samePath(identity.path, canonicalPath, "linux") || !samePath(inputPath, canonicalPath, "linux")) {
      throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    }
    return Object.freeze({
      platform,
      kind,
      path: identity.path,
      device: identity.device,
      inode: identity.inode,
    });
  }

  const keys = Object.keys(identity).sort();
  if (keys.join(",") !== "fileId,kind,path,status,volumeSerial" || identity.status !== "SAFE_PATH" ||
      identity.kind !== kind || typeof identity.path !== "string" || !path.win32.isAbsolute(identity.path) ||
      typeof identity.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(identity.volumeSerial) ||
      typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const reportedPath = identity.path.startsWith("\\\\?\\") ? identity.path.slice(4) : identity.path;
  if (!samePath(reportedPath, canonicalPath, "win32") || !samePath(inputPath, canonicalPath, "win32")) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return Object.freeze({
    platform,
    kind,
    path: identity.path,
    volumeSerial: identity.volumeSerial,
    fileId: identity.fileId,
  });
}

/** Проверяет точную форму native identity chain и его lexical-привязку к auth-root и Run profile. */
export function parseNativeSafePathIdentityChain(
  line: string,
  profileHome: string,
  authRoot: string,
  platform: "win32",
): HermesWindowsPathIdentityChain {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const result = parsed as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "profileHomePathChain,status" || result.status !== "SAFE_PATH_CHAIN" ||
      typeof result.profileHomePathChain !== "object" || result.profileHomePathChain === null ||
      Array.isArray(result.profileHomePathChain)) throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  const rawChain = result.profileHomePathChain as Record<string, unknown>;
  if (Object.keys(rawChain).sort().join(",") !== "authRootIndex,components,version" || rawChain.version !== 1 ||
      !Number.isSafeInteger(rawChain.authRootIndex) || !Array.isArray(rawChain.components) ||
      rawChain.components.length < 2 || rawChain.components.length > 64) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  const components: Array<{ volumeSerial: string; fileId: string }> = [];
  for (const component of rawChain.components) {
    if (typeof component !== "object" || component === null || Array.isArray(component) ||
        Object.keys(component).sort().join(",") !== "fileId,volumeSerial") {
      throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    }
    const identity = component as Record<string, unknown>;
    if (typeof identity.volumeSerial !== "string" || !/^[a-f0-9]{16}$/u.test(identity.volumeSerial) ||
        typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId)) {
      throw resolverError("HERMES_PATH_IDENTITY_INVALID");
    }
    components.push(Object.freeze({ volumeSerial: identity.volumeSerial, fileId: identity.fileId }));
  }
  const paths = path.win32;
  const normalizedHome = paths.normalize(profileHome);
  const normalizedRoot = paths.normalize(authRoot);
  const volumeRoot = paths.parse(normalizedHome).root;
  const relativeProfile = paths.relative(volumeRoot, normalizedHome);
  const profileParts = relativeProfile.split(/[\\/]+/u).filter(Boolean);
  const relativeAuthRoot = paths.relative(volumeRoot, normalizedRoot);
  const authRootParts = relativeAuthRoot.split(/[\\/]+/u).filter(Boolean);
  const runId = paths.basename(normalizedHome).slice("ebb-orchestrator-run-".length);
  const expectedHome = paths.join(normalizedRoot, "profiles", `ebb-orchestrator-run-${runId}`);
  const volumeSerial = components[0]?.volumeSerial;
  if (!paths.isAbsolute(normalizedHome) || !paths.isAbsolute(normalizedRoot) || !volumeRoot ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId) ||
      !samePath(expectedHome, normalizedHome, platform) ||
      !samePath(paths.resolve(normalizedRoot), normalizedRoot, platform) ||
      components.length !== profileParts.length + 1 || rawChain.authRootIndex !== authRootParts.length ||
      rawChain.authRootIndex <= 0 || rawChain.authRootIndex >= components.length ||
      !volumeSerial || components.some((component) => component.volumeSerial !== volumeSerial)) {
    throw resolverError("HERMES_PATH_IDENTITY_INVALID");
  }
  return Object.freeze({
    version: 1,
    authRootIndex: rawChain.authRootIndex as number,
    components: Object.freeze(components),
  });
}

function sameNativeIdentity(left: NativeSafePathIdentity, right: NativeSafePathIdentity): boolean {
  if (left.platform !== right.platform || left.kind !== right.kind || !samePath(left.path, right.path, left.platform)) return false;
  return left.platform === "win32" && right.platform === "win32"
    ? left.volumeSerial === right.volumeSerial && left.fileId === right.fileId
    : left.platform === "linux" && right.platform === "linux" && left.device === right.device && left.inode === right.inode;
}

function createGuardedRunner(
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
  assertIdentityGuards: (guards: readonly PathIdentityGuard[]) => Promise<void>,
  guards: readonly PathIdentityGuard[],
): NonNullable<HermesExecutableResolverOptions["runCommand"]> {
  return async (file, args, options) => {
    await assertIdentityGuards(guards);
    return runner(file, args, options);
  };
}

async function resolveTrustedWindowsGit(
  pathEntries: string[],
  runCommand: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
  verifyAndRemember: (value: string, kind: "file" | "directory") => Promise<NativeSafePathIdentity>,
  assertIdentityGuards: (guards: readonly PathIdentityGuard[]) => Promise<void>,
  powershell: string,
): Promise<{ path: string; powershell: string }> {
  const trusted: string[] = [];
  await verifyAndRemember(powershell, "file");
  for (const directory of pathEntries) {
    const candidate = path.win32.join(directory, "git.exe");
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical || !path.win32.isAbsolute(canonical)) continue;
    const details = await stat(canonical).catch(() => undefined);
    if (!details?.isFile()) continue;
    try {
      await verifyAndRemember(canonical, "file");
    } catch {
      continue;
    }
    const signatureRunner = createGuardedRunner(runCommand, assertIdentityGuards, [
      { path: powershell, kind: "file" },
      { path: canonical, kind: "file" },
    ]);
    if (await verifyAuthenticode(powershell, canonical, signatureRunner) && !trusted.some((item) => samePath(item, canonical, "win32"))) {
      trusted.push(canonical);
    }
  }
  if (trusted.length === 0) throw resolverError("HERMES_GIT_UNTRUSTED");
  return { path: trusted[0]!, powershell };
}

/** Проверяет подпись Git через Windows Authenticode/WinVerifyTrust, не интерполируя путь в script. */
async function verifyAuthenticode(
  powershell: string,
  candidate: string,
  runCommand: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
): Promise<boolean> {
  const script = "$ErrorActionPreference = 'Stop'; " +
    "$candidate = [Environment]::GetEnvironmentVariable('EBB_HERMES_TRUST_CANDIDATE', 'Process'); " +
    "if ([string]::IsNullOrEmpty($candidate)) { exit 2 }; " +
    "$sig = Get-AuthenticodeSignature -LiteralPath $candidate; " +
    "$evidence = [ordered]@{ status = [string]$sig.Status; subject = [string]$sig.SignerCertificate.Subject; " +
    "thumbprint = [string]$sig.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress; " +
    "[Console]::Out.Write($evidence)";
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  try {
    const result = await runCommand(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      cwd: path.win32.dirname(powershell),
      shell: false,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: path.win32.join(systemRoot, "System32"),
        TEMP: process.env.TEMP ?? path.win32.join(systemRoot, "Temp"),
        TMP: process.env.TMP ?? path.win32.join(systemRoot, "Temp"),
        EBB_HERMES_TRUST_CANDIDATE: candidate,
      },
      timeout: 5_000,
      maxBuffer: 512,
    });
    return isPinnedGitAuthenticodeEvidence(result.stdout, result.exitCode, result.stderr);
  } catch {
    return false;
  }
}

/** Проверяет строго закреплённый Git for Windows publisher, а не любой действительный сертификат. */
export function isPinnedGitAuthenticodeEvidence(stdout: string, exitCode: number, stderr: string): boolean {
  if (exitCode !== 0 || stderr !== "" || stdout.length > 512 || stdout.includes("\n") || stdout.includes("\r")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const evidence = parsed as Record<string, unknown>;
  const keys = Object.keys(evidence).sort();
  return keys.length === 3 && keys[0] === "status" && keys[1] === "subject" && keys[2] === "thumbprint" &&
    evidence.status === "Valid" && evidence.subject === TRUSTED_GIT_SIGNER_SUBJECT &&
    typeof evidence.thumbprint === "string" && evidence.thumbprint.toUpperCase() === TRUSTED_GIT_SIGNER_THUMBPRINT;
}

/** Проверяет подпись указанного Windows Git без запуска Git, Hermes или загрузки provider configuration. */
export async function verifyPinnedWindowsGitSignature(candidate: string): Promise<boolean> {
  if (process.platform !== "win32" || !path.win32.isAbsolute(candidate) || hasControlCharacters(candidate)) return false;
  const helperPath = bundledPathVerifierPath("win32");
  try {
    await verifyNativeHelperIntegrity(helperPath, "hermesProfilePath");
    const identity = await verifyNativeWindowsSystemPowerShell(helperPath, process.cwd(), createNativePathVerifierRunner());
    return verifyAuthenticode(identity.path, candidate, createProcessRunner());
  } catch {
    return false;
  }
}

async function canonicalExistingDirectory(value: string, paths: PlatformPaths): Promise<string> {
  if (!paths.isAbsolute(value)) throw resolverError("HERMES_PATH_INVALID");
  const canonical = await realpath(value).catch(() => { throw resolverError("HERMES_PATH_INVALID"); });
  const details = await stat(canonical).catch(() => { throw resolverError("HERMES_PATH_INVALID"); });
  if (!details.isDirectory()) throw resolverError("HERMES_PATH_INVALID");
  return canonical;
}

async function resolvePathEntries(
  pathValue: string,
  cwd: string,
  paths: PlatformPaths,
): Promise<string[]> {
  const entries = new Set<string>();
  for (const rawEntry of pathValue.split(paths.delimiter)) {
    if (!rawEntry || !paths.isAbsolute(rawEntry)) continue;
    const canonical = await realpath(rawEntry).catch(() => undefined);
    if (!canonical || isWithin(cwd, canonical, paths)) continue;
    const details = await stat(canonical).catch(() => undefined);
    if (details?.isDirectory()) entries.add(canonical);
  }
  return [...entries];
}

async function resolveUniqueHermesLauncher(
  pathEntries: string[],
  cwd: string,
  paths: PlatformPaths,
): Promise<string> {
  const name = paths === path.win32 ? "hermes.exe" : "hermes";
  const matches = new Set<string>();
  for (const directory of pathEntries) {
    const candidate = paths.join(directory, name);
    const canonical = await realpath(candidate).catch(() => undefined);
    if (!canonical || !paths.isAbsolute(canonical) || isWithin(cwd, canonical, paths)) continue;
    const details = await stat(canonical).catch(() => undefined);
    if (!details?.isFile()) continue;
    if (paths === path.posix) {
      const executable = await access(canonical, fsConstants.X_OK).then(() => true, () => false);
      if (!executable) continue;
    }
    matches.add(canonical);
  }
  if (matches.size === 0) throw resolverError("HERMES_LAUNCHER_NOT_FOUND");
  if (matches.size !== 1) throw resolverError("HERMES_LAUNCHER_AMBIGUOUS");
  return [...matches][0]!;
}

function buildProbeEnvironment(pathEntries: string[], platform: "win32" | "linux"): Record<string, string> {
  const env: Record<string, string> = {
    PATH: pathEntries.join(platform === "win32" ? path.win32.delimiter : path.posix.delimiter),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
  if (platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  } else {
    for (const key of ["LANG", "LC_ALL"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

function createProcessRunner(): NonNullable<HermesExecutableResolverOptions["runCommand"]> {
  const executor = new ProcessExecutor();
  return async (file, args, options) => {
    const { shell: _shell, ...processOptions } = options;
    void _shell;
    return executor.exec(file, args, processOptions);
  };
}

function createNativePathVerifierRunner(): NonNullable<HermesExecutableResolverOptions["runCommand"]> {
  return async (file, args, options) => {
    const { shell: _shell, ...processOptions } = options;
    void _shell;
    return runVerifiedNativeHelper(file, "hermesProfilePath", args, processOptions);
  };
}

async function runBounded(
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
  file: string,
  args: string[],
  options: HermesResolverCommandOptions,
  failureCode: string,
): Promise<ProcessResult> {
  try {
    return await runner(file, args, options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HERMES_PATH_")) throw error;
    throw resolverError(failureCode);
  }
}

/**
 * Строит изолированный Python argv для запуска Hermes только из проверенного source snapshot.
 * `-S` отключает system site initialization и executable `.pth` hooks. После установки Finder
 * добавляются только `purelib`/`platlib` из подтверждённого runtime root, а Hermes modules
 * разрешаются исключительно внутри opaque verified snapshot.
 *
 * @param input Проверенные пути runtime и идентичность исходного snapshot.
 * @param input.snapshot Opaque snapshot object, созданный materialize/lookup после полной проверки.
 * @param input.runtimeDependencyRoot Проверенный runtime root для Python dependencies.
 * @param input.runtimeExecutablePath Проверенный Python executable, которым будет запущен bootstrap.
 * @param input.sourceVersion Неизменённая pinned-версия Hermes.
 * @param input.sourceCommit Неизменённый pinned commit Hermes.
 * @returns Аргументы Python с bytecode cache disabled и bootstrap, ограниченным snapshot root.
 * @throws {Error} Если snapshot path отсутствует/небезопасен или source identity не совпадает с pin.
 */
export function buildHermesSnapshotRuntimeArgs(input: {
  readonly snapshot: HermesSourceSnapshot;
  readonly runtimeDependencyRoot: string;
  readonly runtimeExecutablePath: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
}): readonly string[] {
  const { snapshot, runtimeDependencyRoot, runtimeExecutablePath, sourceVersion, sourceCommit } = input;
  if (!isVerifiedHermesSourceSnapshot(snapshot)) {
    throw resolverError("HERMES_SOURCE_SNAPSHOT_REQUIRED");
  }
  const snapshotRoot = snapshot.rootPath;
  if (!path.posix.isAbsolute(snapshotRoot) && !path.win32.isAbsolute(snapshotRoot) ||
      hasControlCharacters(snapshotRoot) || typeof runtimeDependencyRoot !== "string" ||
      hasControlCharacters(runtimeDependencyRoot) ||
      !(path.posix.isAbsolute(runtimeDependencyRoot) || path.win32.isAbsolute(runtimeDependencyRoot)) ||
      typeof runtimeExecutablePath !== "string" || hasControlCharacters(runtimeExecutablePath) ||
      !(path.posix.isAbsolute(runtimeExecutablePath) || path.win32.isAbsolute(runtimeExecutablePath))) {
    throw resolverError("HERMES_SOURCE_SNAPSHOT_REQUIRED");
  }
  if (sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
      sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit) {
    throw resolverError("HERMES_SOURCE_PIN_MISMATCH");
  }
  let snapshotIdentity: unknown;
  try {
    snapshotIdentity = JSON.parse(snapshot.cacheKey) as unknown;
  } catch {
    throw resolverError("HERMES_SOURCE_SNAPSHOT_REQUIRED");
  }
  if (typeof snapshotIdentity !== "object" || snapshotIdentity === null ||
      (snapshotIdentity as { hermesVersion?: unknown }).hermesVersion !== sourceVersion ||
      (snapshotIdentity as { sourceCommit?: unknown }).sourceCommit !== sourceCommit) {
    throw resolverError("HERMES_SOURCE_PIN_MISMATCH");
  }
  const rootLiteral = pythonUnicodeEscape(snapshotRoot);
  const runtimeRootLiteral = pythonUnicodeEscape(runtimeDependencyRoot);
  const runtimeExecutableLiteral = pythonUnicodeEscape(runtimeExecutablePath);
  const bootstrap =
    "import os, sys, runpy, importlib.abc, importlib.machinery, sysconfig\n" +
    "sys.dont_write_bytecode = True\n" +
    `SNAPSHOT_ROOT = os.path.realpath(${rootLiteral})\n` +
    `RUNTIME_ROOT = os.path.realpath(${runtimeRootLiteral})\n` +
    `RUNTIME_EXECUTABLE = os.path.realpath(${runtimeExecutableLiteral})\n` +
    "def is_within(root, candidate):\n" +
    "    try:\n" +
    "        return os.path.normcase(os.path.commonpath([root, candidate])) == os.path.normcase(root)\n" +
    "    except (OSError, ValueError):\n" +
    "        return False\n" +
    "class HermesSnapshotFinder(importlib.abc.MetaPathFinder):\n" +
    "    def find_spec(self, fullname, path=None, target=None):\n" +
    "        if not (fullname == 'hermes' or fullname.startswith('hermes.') or fullname.startswith('hermes_')):\n" +
    "            return None\n" +
    "        search_path = [SNAPSHOT_ROOT] if path is None else path\n" +
    "        spec = importlib.machinery.PathFinder.find_spec(fullname, search_path, target)\n" +
    "        if spec is None:\n" +
    "            raise ModuleNotFoundError(fullname + ' is absent from the verified Hermes snapshot')\n" +
    "        locations = list(spec.submodule_search_locations or [])\n" +
    "        origins = ([spec.origin] if spec.origin not in (None, 'built-in', 'frozen') else []) + locations\n" +
    "        if not origins:\n" +
    "            raise ImportError(fullname + ' has no snapshot-backed origin')\n" +
    "        for origin in origins:\n" +
    "            if not is_within(SNAPSHOT_ROOT, os.path.realpath(origin)):\n" +
    "                raise ImportError(fullname + ' resolved outside the verified Hermes snapshot')\n" +
    "        return spec\n" +
    "sys.meta_path.insert(0, HermesSnapshotFinder())\n" +
    "if not is_within(RUNTIME_ROOT, os.path.realpath(sys.executable)):\n" +
    "    raise SystemExit('HERMES_RUNTIME_LAYOUT_UNSUPPORTED')\n" +
    "if os.path.normcase(os.path.realpath(sys.executable)) != os.path.normcase(RUNTIME_EXECUTABLE):\n" +
    "    raise SystemExit('HERMES_RUNTIME_LAYOUT_UNSUPPORTED')\n" +
    "runtime_vars = dict(sysconfig.get_config_vars())\n" +
    "runtime_vars.update({'base': RUNTIME_ROOT, 'platbase': RUNTIME_ROOT, 'installed_base': RUNTIME_ROOT, 'installed_platbase': RUNTIME_ROOT})\n" +
    "runtime_paths = sysconfig.get_paths(vars=runtime_vars)\n" +
    "dependency_roots = {os.path.realpath(runtime_paths[name]) for name in ('purelib', 'platlib') if runtime_paths.get(name)}\n" +
    "if not dependency_roots or any(not is_within(RUNTIME_ROOT, root) or not os.path.isdir(root) for root in dependency_roots):\n" +
    "    raise SystemExit('HERMES_RUNTIME_LAYOUT_UNSUPPORTED')\n" +
    "sys.path.insert(0, SNAPSHOT_ROOT)\n" +
    "sys.path.extend(sorted(dependency_roots))\n" +
    "from hermes_constants import get_default_hermes_root\n" +
    "os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(get_default_hermes_root())\n" +
    "import hermes_bootstrap\n" +
    "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)\n";
  return Object.freeze(["-I", "-B", "-S", "-c", bootstrap]);
}

function failClosedRuntimeArgsPrefix(): readonly string[] {
  return Object.freeze(["-I", "-B", "-S", "-c", "raise SystemExit('HERMES_SOURCE_SNAPSHOT_REQUIRED')"]);
}

/**
 * Вычисляет точный wrapper из pinned Hermes `_launcher_script` без исполнения Python.
 * Реализована только форма Python/Windows, остальные launcher layouts fail-closed.
 *
 * @param sourceRoot Абсолютный `<home>\\hermes-agent` из стандартного installer layout.
 * @returns Точный source template, с которым сравниваются embedded ZIP и `.cmd` payload.
 * @throws {Error} Если путь не является абсолютным или содержит управляющие символы.
 */
export function pinnedWindowsLauncherScript(sourceRoot: string): string {
  if (!path.win32.isAbsolute(sourceRoot) || hasControlCharacters(sourceRoot)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const literal = pythonRepr(sourceRoot);
  return "import os, re, sys\n" +
    "os.environ.pop('PYTHONHOME', None)\n" +
    "os.environ.pop('PYTHONPATH', None)\n" +
    `sys.path.insert(0, ${literal})\n` +
    "from hermes_constants import get_default_hermes_root\n" +
    "os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(get_default_hermes_root())\n" +
    "import hermes_bootstrap\n" +
    "if sys.argv[1:2] == ['--run-module']:\n" +
    "    import runpy\n" +
    "    if len(sys.argv) < 3: sys.exit('hermes: --run-module needs a module')\n" +
    "    module = sys.argv.pop(2)\n" +
    "    del sys.argv[1]\n" +
    "    runpy.run_module(module, run_name='__main__', alter_sys=True)\n" +
    "    sys.exit(0)\n" +
    "from hermes_cli.main import main\n" +
    "sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])\n" +
    "sys.exit(main())\n";
}

/** Читает PE/ZIP data как ограниченный формат, не загружая и не исполняя launcher. */
export function inspectPinnedWindowsLauncher(executable: Buffer, sourceRoot: string): {
  readonly pythonExecutable: string;
  readonly scriptBytes: Buffer;
} {
  if (executable.byteLength > MAX_LAUNCHER_BYTES || executable.byteLength < 128 ||
      executable.toString("ascii", 0, 2) !== "MZ") {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const peOffset = executable.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 4 > executable.byteLength ||
      executable.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const { zipStart, scriptBytes } = readSingleLauncherZip(executable);
  const expected = Buffer.from(pinnedWindowsLauncherScript(sourceRoot), "utf8");
  if (!scriptBytes.equals(expected)) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");

  const prefix = executable.subarray(0, zipStart);
  const shebangStart = prefix.lastIndexOf(Buffer.from("#!", "ascii"));
  if (shebangStart < peOffset + 4) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const shebang = prefix.subarray(shebangStart).toString("utf8");
  const match = /^#!(.+) -I\n$/u.exec(shebang);
  if (!match || !path.win32.isAbsolute(match[1]!) || hasControlCharacters(match[1]!)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  return Object.freeze({ pythonExecutable: match[1]!, scriptBytes });
}

function readSingleLauncherZip(executable: Buffer): { zipStart: number; scriptBytes: Buffer } {
  const searchStart = Math.max(0, executable.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = executable.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (executable.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 > executable.byteLength || executable.readUInt16LE(offset + 20) !== 0) continue;
    if (offset + 22 !== executable.byteLength) continue;
    if (endOffset !== -1) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
    endOffset = offset;
  }
  if (endOffset < 0 || executable.readUInt16LE(endOffset + 4) !== 0 ||
      executable.readUInt16LE(endOffset + 6) !== 0 || executable.readUInt16LE(endOffset + 8) !== 1 ||
      executable.readUInt16LE(endOffset + 10) !== 1) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const centralSize = executable.readUInt32LE(endOffset + 12);
  const centralOffset = executable.readUInt32LE(endOffset + 16);
  const zipStart = endOffset - centralSize - centralOffset;
  if (zipStart < 0 || zipStart >= endOffset || centralSize < 46 ||
      zipStart + centralOffset + centralSize !== endOffset) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const central = zipStart + centralOffset;
  if (executable.readUInt32LE(central) !== 0x02014b50) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const flags = executable.readUInt16LE(central + 8);
  const method = executable.readUInt16LE(central + 10);
  const expectedCrc = executable.readUInt32LE(central + 16);
  const compressedSize = executable.readUInt32LE(central + 20);
  const uncompressedSize = executable.readUInt32LE(central + 24);
  const nameLength = executable.readUInt16LE(central + 28);
  const extraLength = executable.readUInt16LE(central + 30);
  const commentLength = executable.readUInt16LE(central + 32);
  const diskNumber = executable.readUInt16LE(central + 34);
  const localOffset = executable.readUInt32LE(central + 42);
  const nameStart = central + 46;
  const name = executable.toString("ascii", nameStart, nameStart + nameLength);
  if (flags !== 0 || (method !== 0 && method !== 8) || diskNumber !== 0 || name !== "__main__.py" ||
      uncompressedSize > MAX_LAUNCHER_SCRIPT_BYTES || compressedSize > MAX_LAUNCHER_SCRIPT_BYTES ||
      nameStart + nameLength + extraLength + commentLength !== endOffset || localOffset >= centralOffset) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const local = zipStart + localOffset;
  if (local + 30 > central || executable.readUInt32LE(local) !== 0x04034b50 ||
      executable.readUInt16LE(local + 6) !== flags || executable.readUInt16LE(local + 8) !== method ||
      executable.readUInt32LE(local + 14) !== expectedCrc || executable.readUInt32LE(local + 18) !== compressedSize ||
      executable.readUInt32LE(local + 22) !== uncompressedSize) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const localNameLength = executable.readUInt16LE(local + 26);
  const localExtraLength = executable.readUInt16LE(local + 28);
  if (executable.toString("ascii", local + 30, local + 30 + localNameLength) !== "__main__.py" ||
      localNameLength !== nameLength) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const bodyStart = local + 30 + localNameLength + localExtraLength;
  const bodyEnd = bodyStart + compressedSize;
  if (bodyEnd > central) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const compressed = executable.subarray(bodyStart, bodyEnd);
  let scriptBytes: Buffer;
  try {
    scriptBytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_LAUNCHER_SCRIPT_BYTES });
  } catch {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  if (scriptBytes.byteLength !== uncompressedSize || crc32(scriptBytes) !== expectedCrc) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  return { zipStart, scriptBytes };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function verifyWindowsCommandSidecar(pathname: string, pythonPath: string, expectedScript: Buffer): Promise<void> {
  const details = await lstat(pathname).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  });
  if (!details) return;
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SIDECAR_BYTES) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
  const content = await readFile(pathname, "utf8").catch(() => { throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH"); });
  const match = /^@echo off\r\n"([^"\r\n]+)" -I -c "import base64; exec\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)" %\*\r\n$/u.exec(content);
  if (!match || !samePath(match[1]!, pythonPath, "win32")) throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  const encoded = match[2]!;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded || !decoded.equals(expectedScript)) {
    throw resolverError("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  }
}

function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return `${quote}${value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
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

async function verifyInstallStamp(
  hermesProjectRoot: string,
  platform: "win32" | "linux" = "win32",
): Promise<Record<string, unknown>> {
  const stampPath = platformPaths(platform).join(hermesProjectRoot, "install-stamp.json");
  let contents: string;
  if (platform === "linux") {
    contents = (await readBoundedPosixFile(stampPath, INSTALL_STAMP_MAX_BYTES, "HERMES_SOURCE_VERSION_MISMATCH"))
      .toString("utf8");
  } else {
    const details = await lstat(stampPath).catch(() => { throw resolverError("HERMES_SOURCE_VERSION_MISMATCH"); });
    if (!details.isFile() || details.isSymbolicLink() || details.size > INSTALL_STAMP_MAX_BYTES) {
      throw resolverError("HERMES_SOURCE_VERSION_MISMATCH");
    }
    contents = await readFile(stampPath, "utf8").catch(() => { throw resolverError("HERMES_SOURCE_VERSION_MISMATCH"); });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw resolverError("HERMES_SOURCE_VERSION_MISMATCH");
  }
  const pinnedBaseVersion = HERMES_PROVIDER_SELECTION_SOURCE.version.match(/^v(\d+\.\d+\.\d+)\+/)?.[1];
  if (
    !pinnedBaseVersion || typeof value !== "object" || value === null ||
    (value as { baseVersion?: unknown }).baseVersion !== pinnedBaseVersion
  ) {
    throw resolverError("HERMES_SOURCE_VERSION_MISMATCH");
  }
  return value as Record<string, unknown>;
}

async function verifyPinnedGitSource(
  hermesProjectRoot: string,
  cwd: string,
  env: Record<string, string>,
  platform: "win32" | "linux",
  gitExecutable: string,
  runner: NonNullable<HermesExecutableResolverOptions["runCommand"]>,
): Promise<string> {
  const gitArgs = (args: string[]) => [
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "diff.external=", "--no-ext-diff",
    "-C", hermesProjectRoot, ...args,
  ];
  const commandOptions: HermesResolverCommandOptions = {
    shell: false,
    cwd,
    env,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
  };
  const topLevel = await runBounded(runner, gitExecutable, gitArgs(["rev-parse", "--show-toplevel"]), commandOptions, "HERMES_SOURCE_PIN_MISMATCH");
  const head = await runBounded(runner, gitExecutable, gitArgs(["rev-parse", "--verify", "HEAD^{commit}" ]), commandOptions, "HERMES_SOURCE_PIN_MISMATCH");
  const tree = await runBounded(runner, gitExecutable, gitArgs(["rev-parse", "--verify", "HEAD^{tree}" ]), commandOptions, "HERMES_SOURCE_PIN_MISMATCH");
  const diff = await runBounded(runner, gitExecutable, gitArgs(["diff", "--quiet", "HEAD", "--"]), commandOptions, "HERMES_SOURCE_DIRTY");
  const status = await runBounded(runner, gitExecutable, gitArgs(["status", "--porcelain=v1", "--untracked-files=all"]), commandOptions, "HERMES_SOURCE_DIRTY");
  if (
    topLevel.exitCode !== 0 || topLevel.stderr !== "" ||
    !samePath(normalizeOutputLine(topLevel.stdout), hermesProjectRoot, platform) ||
    head.exitCode !== 0 || head.stderr !== "" || normalizeOutputLine(head.stdout) !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
    tree.exitCode !== 0 || tree.stderr !== "" || !new RegExp(`^[0-9a-f]{${HERMES_PROVIDER_SELECTION_SOURCE.commit.length}}$`, "u").test(normalizeOutputLine(tree.stdout))
  ) {
    throw resolverError("HERMES_SOURCE_PIN_MISMATCH");
  }
  if (diff.exitCode !== 0 || diff.stdout !== "" || diff.stderr !== "" || status.exitCode !== 0 || status.stdout !== "" || status.stderr !== "") {
    throw resolverError("HERMES_SOURCE_DIRTY");
  }
  return normalizeOutputLine(tree.stdout);
}

function normalizeOutputLine(output: string): string {
  if (output.length > COMMAND_MAX_BUFFER) return "";
  const line = output.endsWith("\r\n") ? output.slice(0, -2) : output.endsWith("\n") ? output.slice(0, -1) : "";
  return line && !line.includes("\n") && !line.includes("\r") ? line : "";
}

function samePath(left: string, right: string, platform: "win32" | "linux"): boolean {
  if (!left) return false;
  const paths = platformPaths(platform);
  const normalizedLeft = paths.normalize(left);
  const normalizedRight = paths.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isWithin(parent: string, candidate: string, paths: PlatformPaths): boolean {
  const relative = paths.relative(parent, candidate);
  return relative === "" || (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`));
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function nativePathVerifierFailure(error: unknown): Error {
  if (!(error instanceof Error) || error.name !== "ExitCodeError") {
    return resolverError("HERMES_PATH_TRUST_UNAVAILABLE");
  }
  const exitCode = (error as Error & { readonly exitCode?: unknown }).exitCode;
  if (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) {
    return resolverError("HERMES_PATH_TRUST_UNAVAILABLE");
  }
  // Native path verifier exit codes are stable policy/input rejections; gate, integrity,
  // launch, timeout, and unknown exit failures remain an unavailable trust boundary.
  const policyRejection = [2, 10, 30, 31, 34, 40].includes(exitCode) || (exitCode >= 50 && exitCode <= 56);
  return resolverError(policyRejection ? "HERMES_PATH_UNSAFE" : "HERMES_PATH_TRUST_UNAVAILABLE");
}

function resolverError(code: string): Error {
  return new Error(code);
}
