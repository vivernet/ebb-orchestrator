import {
  basename as posixBasename,
  dirname as posixDirname,
  isAbsolute as isPosixAbsolute,
  join as posixJoin,
  normalize as posixNormalize,
} from 'node:path/posix';
import {
  basename as windowsBasename,
  dirname as windowsDirname,
  isAbsolute as isWindowsAbsolute,
  join as windowsJoin,
  normalize as windowsNormalize,
} from 'node:path/win32';
import process from 'node:process';
import { verifyNativeHelperIntegrity } from '../process/native-helper-integrity.js';
import { runVerifiedNativeHelper } from '../process/native-helper-launcher.js';

export interface HermesProfilePathHelperOptions {
  hermesRoot: string;
  runId: string;
  helperPath: string;
  platform: 'win32' | 'linux';
  runHelper?: (executable: string, args: string[], options: { shell: false; input?: string }) => void | Promise<void>;
  /** Узкий seam для тестов; production сверяет helper с parent-code SHA anchor. */
  verifyHelper?: (helperPath: string, anchorName: 'hermesProfilePath') => void | Promise<void>;
}

export interface HermesRunProfileConfigWriteOptions {
  profileHome: string;
  runId: string;
  helperPath: string;
  platform: 'win32' | 'linux';
  configYaml: string;
  runHelper?: (executable: string, args: string[], options: { shell: false; input?: string }) => void | Promise<void>;
  /** Узкий seam для тестов; production сверяет helper с parent-code SHA anchor. */
  verifyHelper?: (helperPath: string, anchorName: 'hermesProfilePath') => void | Promise<void>;
}

/** Opaque runtime proof issued only after the production native helper creates the exact Run profile. */
export interface HermesRunProfileCreationReceipt {
  readonly runId: string;
  readonly hermesRoot: string;
  readonly profileHome: string;
}

const verifiedProfileCreationReceipts = new WeakMap<object, HermesRunProfileCreationReceipt>();

export type HermesRunProfileConfigWriter = (
  options: HermesRunProfileConfigWriteOptions,
) => Promise<void>;

/**
 * Создаёт новый Hermes profile через нативный helper, удерживающий проверенные OS handles.
 * Путь строится только после успешного создания; TypeScript не проверяет и не создаёт его
 * path-based файловыми операциями. Helper обязан открыть все компоненты без symlink/reparse,
 * оставить ACL auth-root неизменным и создать отдельный закрытый каталог именно под auth-root.
 *
 * @param options Auth-owning Hermes root, canonical lowercase UUID Run ID и собранный native helper.
 * @returns Точный Hermes `HERMES_HOME` внутри `<root>/profiles/ebb-orchestrator-run-<id>`.
 * @throws {Error} Если вход неоднозначен, платформа не поддерживается или нативная проверка не прошла.
 */
export async function createHermesRunProfileHome(options: HermesProfilePathHelperOptions): Promise<string> {
  return (await createHermesRunProfileHomeCore(options)).profileHome;
}

/**
 * Создаёт точный per-Run profile и возвращает opaque receipt для source-backed auth projection.
 * Receipt выдаётся только при production запуске проверенного native helper; test runner seams
 * могут проверять результат создания, но не могут выпустить authority для binder.
 *
 * @param options Hermes root, Run UUID, integrity-pinned native helper и поддерживаемая платформа.
 * @returns Точный путь профиля и неподлежащее структурной подделке подтверждение его создания.
 * @throws {Error} Стабильный код, если валидация или создание native helper не прошли.
 */
export async function createHermesRunProfileHomeWithReceipt(
  options: HermesProfilePathHelperOptions,
): Promise<HermesRunProfileCreationReceipt> {
  const receipt = await createHermesRunProfileHomeCore(options);
  if (!options.runHelper && !options.verifyHelper) verifiedProfileCreationReceipts.set(receipt, receipt);
  return receipt;
}

/** Checks exact-object provenance and Run/root/path binding without trusting caller fields alone. */
export function isVerifiedHermesRunProfileCreationReceipt(
  value: unknown,
  expected: Pick<HermesRunProfileCreationReceipt, 'runId' | 'hermesRoot' | 'profileHome'>,
): value is HermesRunProfileCreationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = verifiedProfileCreationReceipts.get(value);
  return receipt !== undefined && receipt.runId === expected.runId &&
    receipt.hermesRoot === expected.hermesRoot && receipt.profileHome === expected.profileHome;
}

async function createHermesRunProfileHomeCore(options: HermesProfilePathHelperOptions): Promise<HermesRunProfileCreationReceipt> {
  const { hermesRoot, runId, helperPath, platform } = options;
  if ((platform !== 'win32' && platform !== 'linux') || !isSafeRunId(runId) ||
      !isAbsoluteForPlatform(hermesRoot, platform) || !isAbsoluteForPlatform(helperPath, platform) ||
      containsControlCharacters(hermesRoot) || containsControlCharacters(helperPath)) {
    throw new Error('HERMES_PROFILE_PATH_INPUT_INVALID');
  }

  try {
    await (options.verifyHelper ?? verifyNativeHelperIntegrity)(helperPath, 'hermesProfilePath');
    const runHelper = options.runHelper ?? executeHermesProfilePathHelper;
    await runHelper(helperPath, ['create-profile', hermesRoot, runId], { shell: false });
  } catch {
    // Не переносить в ошибку пути, OS diagnostics или содержимое child stderr.
    throw new Error('HERMES_PROFILE_PATH_CREATE_FAILED');
  }

  const profileHome = joinForPlatform(hermesRoot, 'profiles', `ebb-orchestrator-run-${runId}`, platform);
  return Object.freeze({ runId, hermesRoot, profileHome });
}

/**
 * Создаёт `home/` и записывает Orchestrator-owned config через проверенные native handles.
 * Команда получает только Hermes root и Run UUID как argv; ограниченный non-secret YAML передаётся
 * по stdin, чтобы не помещать содержимое конфигурации в command line или diagnostics. Native helper
 * открывает точный `<root>/profiles/ebb-orchestrator-run-<id>` без reparse, проверяет ACL/owner и
 * выполняет обе операции относительно удерживаемого profile handle.
 *
 * @param options Точный profile path, Run UUID, integrity-pinned native helper и сгенерированный YAML.
 * @throws {Error} Если путь/вход не совпадает с Run binding либо native helper отказывает.
 */
export async function writeHermesRunProfileConfig(options: HermesRunProfileConfigWriteOptions): Promise<void> {
  const { profileHome, runId, helperPath, configYaml } = options;
  const platform = options.platform;
  if ((platform !== 'win32' && platform !== 'linux') || !isSafeRunId(runId) ||
      !isAbsoluteForPlatform(profileHome, platform) || !isAbsoluteForPlatform(helperPath, platform) ||
      containsControlCharacters(profileHome) || containsControlCharacters(helperPath) ||
      typeof configYaml !== 'string' || configYaml.length === 0 ||
      configYaml.includes('\0') || Buffer.byteLength(configYaml, 'utf8') > 64 * 1024) {
    throw new Error('HERMES_PROFILE_CONFIG_WRITE_INPUT_INVALID');
  }

  const paths = platform === 'win32'
    ? { normalize: windowsNormalize, dirname: windowsDirname, basename: windowsBasename, join: windowsJoin }
    : { normalize: posixNormalize, dirname: posixDirname, basename: posixBasename, join: posixJoin };
  const normalizedProfileHome = paths.normalize(profileHome);
  const hermesRoot = paths.dirname(paths.dirname(normalizedProfileHome));
  const exactProfileHome = paths.normalize(paths.join(hermesRoot, 'profiles', `ebb-orchestrator-run-${runId}`));
  const sameProfilePath = platform === 'win32'
    ? sameWindowsPath(normalizedProfileHome, exactProfileHome)
    : normalizedProfileHome === exactProfileHome;
  const profilesName = paths.basename(paths.dirname(normalizedProfileHome));
  if (!sameProfilePath || (platform === 'win32' ? profilesName.toLowerCase() !== 'profiles' : profilesName !== 'profiles')) {
    throw new Error('HERMES_PROFILE_CONFIG_WRITE_INPUT_INVALID');
  }

  try {
    await (options.verifyHelper ?? verifyNativeHelperIntegrity)(helperPath, 'hermesProfilePath');
    const runHelper = options.runHelper ?? executeHermesProfilePathHelper;
    await runHelper(helperPath, ['initialize-run-profile', hermesRoot, runId], {
      shell: false,
      input: configYaml,
    });
  } catch {
    // Не переносить в ошибку пути, OS diagnostics или содержимое config.
    throw new Error('HERMES_PROFILE_CONFIG_WRITE_FAILED');
  }
}

/**
 * Удаляет только точный пустой per-Run Hermes profile после rollback до записи config/запуска Hermes.
 * Проверка root, `profiles/`, Run UUID, ACL/владельца, непустоты и фактическое удаление выполняются
 * native helper по удерживаемым handles; этот слой намеренно не использует path-based fs API.
 * Удаление отсутствующего leaf является идемпотентным, а неожиданный файл или небезопасный путь
 * приводит к отказу без рекурсивного удаления содержимого.
 *
 * @param options Auth-owning Hermes root, точный Run ID, bundled helper и platform runner.
 * @throws {Error} Стабильный код, если нативная проверка либо удаление не выполнены.
 */
export async function cleanupHermesRunProfileHome(options: HermesProfilePathHelperOptions): Promise<void> {
  const { hermesRoot, runId, helperPath, platform } = options;
  if ((platform !== 'win32' && platform !== 'linux') || !isSafeRunId(runId) ||
      !isAbsoluteForPlatform(hermesRoot, platform) || !isAbsoluteForPlatform(helperPath, platform) ||
      containsControlCharacters(hermesRoot) || containsControlCharacters(helperPath)) {
    throw new Error('HERMES_PROFILE_PATH_INPUT_INVALID');
  }

  try {
    await (options.verifyHelper ?? verifyNativeHelperIntegrity)(helperPath, 'hermesProfilePath');
    const runHelper = options.runHelper ?? executeHermesProfilePathHelper;
    await runHelper(helperPath, ['cleanup-profile', hermesRoot, runId], { shell: false });
  } catch {
    throw new Error('HERMES_PROFILE_PATH_CLEANUP_FAILED');
  }
}

async function executeHermesProfilePathHelper(
  executable: string,
  args: string[],
  options: { shell: false; input?: string },
): Promise<void> {
  const childEnvironment = process.platform === 'win32'
    ? {
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      }
    : { PATH: '/usr/bin:/bin' };
  await runVerifiedNativeHelper(executable, 'hermesProfilePath', args, {
    timeout: 5_000,
    maxBuffer: 8_192,
    env: childEnvironment,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

function isSafeRunId(runId: string): boolean {
  return typeof runId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId);
}

function isAbsoluteForPlatform(value: string, platform: 'win32' | 'linux'): boolean {
  return typeof value === 'string' && (platform === 'win32' ? isWindowsAbsolute(value) : isPosixAbsolute(value));
}

function joinForPlatform(root: string, profiles: string, name: string, platform: 'win32' | 'linux'): string {
  return platform === 'win32'
    ? windowsNormalize(windowsJoin(root, profiles, name))
    : posixNormalize(posixJoin(root, profiles, name));
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
