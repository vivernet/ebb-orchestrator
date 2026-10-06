import { isAbsolute as isPosixAbsolute } from 'node:path/posix';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import process from 'node:process';
import { runVerifiedNativeHelper } from '../../../platform/process/native-helper-launcher.js';

export const HERMES_PROVIDER_SELECTION_SOURCE = Object.freeze({
  version: 'v0.21.5+7357.g9244275',
  commit: '9244275491ee0d5bc3481590b041114c4e1d399a',
  projectionVersion: 'hermes-config-selection-v1',
  endpointProjectionVersion: 'hermes-endpoint-projection-v1',
});

/**
 * Source-pinned Hermes provider env keys that can replace an overlay's endpoint at runtime.
 * Callers constructing a Hermes child environment must not inherit these keys. Hermes also loads
 * its installation-root dotenv as a fallback; therefore providers that declare one of these keys
 * remain endpoint-identity-ineligible until the effective value can be safely projected.
 */
export const HERMES_PROVIDER_BASE_URL_ENV_VARS = Object.freeze([
  'ACTUAL_BASE_URL',
  'ALIBABA_CODING_PLAN_BASE_URL',
  'ARCEE_BASE_URL',
  'AZURE_FOUNDRY_BASE_URL',
  'COPILOT_ACP_BASE_URL',
  'DASHSCOPE_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'GLM_BASE_URL',
  'GMI_BASE_URL',
  'HERMES_QWEN_BASE_URL',
  'HF_BASE_URL',
  'KILOCODE_BASE_URL',
  'KIMI_BASE_URL',
  'LM_BASE_URL',
  'MINIMAX_BASE_URL',
  'MINIMAX_CN_BASE_URL',
  'NEBIUS_BASE_URL',
  'NOVITA_BASE_URL',
  'NVIDIA_BASE_URL',
  'OLLAMA_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENCODE_GO_BASE_URL',
  'OPENCODE_ZEN_BASE_URL',
  'OPENROUTER_BASE_URL',
  'STEPFUN_BASE_URL',
  'TOKENHUB_BASE_URL',
  'TOKENPLAN_BASE_URL',
  'UPSTAGE_BASE_URL',
  'XAI_BASE_URL',
  'XIAOMI_BASE_URL',
] as const);

const SOURCE_LITERAL_ENDPOINT_PROVIDERS = new Set([
  'actual', 'arcee', 'copilot-acp', 'fireworks', 'gmi', 'lmstudio', 'minimax-oauth', 'moa',
  'nebius-token-factory', 'nvidia', 'nous', 'ollama-cloud', 'openai-api', 'openai-codex',
  'qwen-oauth', 'stepfun', 'tencent-tokenplan', 'upstage', 'xai', 'xai-oauth',
]);

const PROVIDERS_WITH_RUNTIME_ENDPOINT_ENV = new Set([
  'actual', 'alibaba', 'alibaba-coding-plan', 'arcee', 'azure-foundry', 'copilot-acp',
  'deepseek', 'huggingface', 'kimi-for-coding', 'kilo', 'lmstudio', 'minimax', 'minimax-cn',
  'nebius-token-factory', 'novita', 'nvidia', 'ollama-cloud', 'opencode', 'opencode-go',
  'openai-api', 'openrouter', 'qwen-oauth', 'stepfun', 'tencent-tokenhub', 'tencent-tokenplan',
  'upstage', 'xai', 'xai-oauth', 'xiaomi', 'zai',
]);

const SOURCE_LITERAL_ENDPOINT_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  actual: 'ACTUAL_BASE_URL',
  arcee: 'ARCEE_BASE_URL',
  'copilot-acp': 'COPILOT_ACP_BASE_URL',
  gmi: 'GMI_BASE_URL',
  lmstudio: 'LM_BASE_URL',
  'nebius-token-factory': 'NEBIUS_BASE_URL',
  nvidia: 'NVIDIA_BASE_URL',
  'ollama-cloud': 'OLLAMA_BASE_URL',
  'openai-api': 'OPENAI_BASE_URL',
  'qwen-oauth': 'HERMES_QWEN_BASE_URL',
  stepfun: 'STEPFUN_BASE_URL',
  'tencent-tokenplan': 'TOKENPLAN_BASE_URL',
  upstage: 'UPSTAGE_BASE_URL',
  xai: 'XAI_BASE_URL',
  'xai-oauth': 'XAI_BASE_URL',
});

export interface HermesProviderSelection {
  providerId: string;
  modelId: string;
  endpointOverridePresent: boolean;
  /** True only when the effective default endpoint is pinned to the Hermes source commit. */
  endpointIdentityEligible: boolean;
  endpointIdentity: string | null;
  endpointRevision: string | null;
  reason?: 'HERMES_ENDPOINT_ID_UNAVAILABLE';
}

export interface HermesProviderSelectionReaderOptions {
  hermesConfigHome: string;
  /**
   * Planned `<hermesConfigHome>/profiles/ebb-orchestrator-run-<runId>` path. It may be absent:
   * endpoint projection verifies the exact root/Run binding through the native helper and never
   * creates the directory. If it already exists, it must be the private per-Run profile without
   * `config.yaml` or `.op.env`. Invoke before native profile creation and before writing the
   * Orchestrator-owned `config.yaml`.
   */
  hermesRunProfileHome: string;
  /** Canonical lowercase UUIDv4 that must match the planned profile leaf. */
  runId: string;
  /**
   * Hermes install `PROJECT_ROOT`, derived by the caller from the exact executable already
   * verified against this source pin. This module validates the path through the native helper,
   * but does not establish the executable-to-root provenance itself; callers must not use PATH,
   * CWD, or an unverified launcher to populate it.
   */
  hermesProjectRoot: string;
  /** Prepared Hermes child environment; only the selected endpoint key is read as a value. */
  runEnvironment: Readonly<Record<string, string | undefined>>;
  helperPath: string;
  platform: 'win32' | 'linux';
  runHelper?: (executable: string, args: string[], options: { shell: false; maxOutputBytes: number; input?: string }) => string | Promise<string>;
}

interface NativeSelectionProjection {
  sourceVersion: string;
  sourceCommit: string;
  projectionVersion: string;
  status: 'EXPLICIT_SELECTION' | 'UNAVAILABLE';
  reason?: string;
  providerId?: string;
  modelId?: string;
  endpointOverridePresent: boolean;
}

const SAFE_UNAVAILABLE_REASONS = new Set([
  'HERMES_SELECTION_NOT_EXPLICIT',
  'HERMES_SELECTION_CONFIG_UNSUPPORTED',
  'HERMES_SELECTION_CONFIG_UNAVAILABLE',
  'HERMES_SELECTION_MANAGED_SCOPE_UNSUPPORTED',
  'HERMES_SELECTION_PROFILE_UNAVAILABLE',
]);

/**
 * Читает через нативный ограниченный scanner только явные `model.provider` и `model.default`.
 * Helper не возвращает endpoint URL, credential или остальные config-поля; aliases, environment
 * expansion, managed overlay и неканонические config layers приводят к отказу. Endpoint preflight
 * выполняется до создания native per-Run профиля и до записи Orchestrator-owned `config.yaml`.
 * Helper принимает точный запланированный путь
 * `<hermesConfigHome>/profiles/ebb-orchestrator-run-<runId>`, если leaf отсутствует (в том числе
 * когда `profiles/` ещё не существует) либо уже созданный leaf безопасен и пуст; helper не создаёт
 * каталогов. Существующий leaf должен быть приватным Run profile без `config.yaml` и `.op.env`.
 * Не копируйте в профиль
 * конфигурацию пользователя. Для
 * runtime-endpoint overlays scanner только в памяти сравнивает
 * выбранную переменную среды и единственную выбранную dotenv-переменную с literal Hermes source
 * default; выводит только stable source identity либо фиксированный отказ, URL не логируется,
 * не сохраняется, не хешируется и не возвращается. Source pin становится revision: смена pinned
 * Hermes source меняет revision. `hermesProjectRoot` обязан поступить от вызывающей стороны,
 * которая уже проверила точный Hermes executable; эта функция не разрешает launcher и не доказывает
 * executable-to-root provenance. Нельзя получать root из PATH или CWD. `endpointIdentityEligible`
 * относится только к endpoint identity и ничего не утверждает о native auth или готовности Run.
 *
 * @param options Каталог выбранного Hermes config, запланированный Run profile и UUID, проверенный
 *                installation root, подготовленное окружение Run и собранный helper.
 * @returns Ограниченные provider/model IDs и safe endpoint identity result без URL.
 * @throws {Error} Если вход, source pin, конфигурация или helper output не проходят fail-closed проверки.
 */
export async function readHermesProviderSelection(
  options: HermesProviderSelectionReaderOptions,
): Promise<HermesProviderSelection> {
  const { hermesConfigHome, helperPath, platform } = options;
  if ((platform !== 'win32' && platform !== 'linux') || !isAbsoluteForPlatform(hermesConfigHome, platform) ||
      !isAbsoluteForPlatform(helperPath, platform) || !isSafeRunId(options.runId) ||
      containsControlCharacters(hermesConfigHome) || containsControlCharacters(helperPath)) {
    throw new Error('HERMES_SELECTION_INPUT_INVALID');
  }

  let output: string;
  try {
    const runHelper = options.runHelper ?? executeHermesProfilePathHelper;
    output = await runHelper(helperPath, [
      'project-selection', hermesConfigHome, options.hermesRunProfileHome, options.runId,
    ], { shell: false, maxOutputBytes: 2_048 });
  } catch {
    throw new Error('HERMES_SELECTION_READ_FAILED');
  }

  const projection = parseProjection(output);
  if (projection.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
      projection.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
      projection.projectionVersion !== HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion) {
    throw new Error('HERMES_SELECTION_SOURCE_MISMATCH');
  }

  if (projection.status === 'UNAVAILABLE') {
    if (!projection.reason || !SAFE_UNAVAILABLE_REASONS.has(projection.reason)) {
      throw new Error('HERMES_SELECTION_PROJECTION_INVALID');
    }
    throw new Error(projection.reason);
  }

  if (!projection.providerId || !projection.modelId ||
      !isSafeProviderId(projection.providerId) || !isSafeModelId(projection.modelId) ||
      projection.providerId.toLowerCase() === 'auto') {
    throw new Error('HERMES_SELECTION_NOT_EXPLICIT');
  }

  const providerId = projection.providerId.toLowerCase();
  let endpointIdentityEligible = !projection.endpointOverridePresent &&
    SOURCE_LITERAL_ENDPOINT_PROVIDERS.has(providerId) &&
    !PROVIDERS_WITH_RUNTIME_ENDPOINT_ENV.has(providerId);

  const selectedBaseUrlEnvVar = SOURCE_LITERAL_ENDPOINT_ENV_VARS[providerId];
  if (!projection.endpointOverridePresent && SOURCE_LITERAL_ENDPOINT_PROVIDERS.has(providerId) &&
      selectedBaseUrlEnvVar !== undefined) {
    endpointIdentityEligible = await isPinnedDefaultEndpoint(options, providerId, selectedBaseUrlEnvVar, projection.modelId);
  }

  return {
    providerId: projection.providerId,
    modelId: projection.modelId,
    endpointOverridePresent: projection.endpointOverridePresent,
    endpointIdentityEligible,
    endpointIdentity: endpointIdentityEligible ? `hermes-provider:${providerId}` : null,
    endpointRevision: endpointIdentityEligible ? HERMES_PROVIDER_SELECTION_SOURCE.commit : null,
    ...(!endpointIdentityEligible ? { reason: 'HERMES_ENDPOINT_ID_UNAVAILABLE' as const } : {}),
  };
}

async function executeHermesProfilePathHelper(
  executable: string,
  args: string[],
  options: { shell: false; maxOutputBytes: number; input?: string },
): Promise<string> {
  const childEnvironment = process.platform === 'win32'
    ? {
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      }
    : { PATH: '/usr/bin:/bin' };
  const result = await runVerifiedNativeHelper(executable, 'hermesProfilePath', args, {
    timeout: 5_000,
    maxBuffer: options.maxOutputBytes,
    env: childEnvironment,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return result.stdout;
}

async function isPinnedDefaultEndpoint(
  options: HermesProviderSelectionReaderOptions,
  providerId: string,
  envVar: string,
  modelId: string,
): Promise<boolean> {
  if (Object.prototype.hasOwnProperty.call(options.runEnvironment, 'HERMES_MANAGED_DIR')) return false;
  if (!isAbsoluteForPlatform(options.hermesRunProfileHome, options.platform) ||
      !isAbsoluteForPlatform(options.hermesProjectRoot, options.platform) ||
      containsControlCharacters(options.hermesRunProfileHome) || containsControlCharacters(options.hermesProjectRoot)) {
    return false;
  }

  const endpointValue = Object.prototype.hasOwnProperty.call(options.runEnvironment, envVar)
    ? options.runEnvironment[envVar]
    : undefined;
  if (endpointValue !== undefined && typeof endpointValue !== 'string') return false;
  const valueBytes = endpointValue === undefined ? Buffer.alloc(0) : Buffer.from(endpointValue, 'utf8');
  if (valueBytes.byteLength > 8_192) return false;
  const input = endpointValue === undefined
    ? '0\n0\n'
    : `1\n${valueBytes.byteLength}\n${valueBytes.toString('utf8')}`;

  try {
    const runHelper = options.runHelper ?? executeHermesProfilePathHelper;
    const output = await runHelper(options.helperPath, [
      'project-endpoint',
      options.hermesConfigHome,
      options.hermesRunProfileHome,
      options.hermesProjectRoot,
      providerId,
      modelId,
      envVar,
      options.runId,
    ], { shell: false, maxOutputBytes: 2_048, input });
    const projection = parseEndpointProjection(output);
    if (projection.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
        projection.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
        projection.projectionVersion !== HERMES_PROVIDER_SELECTION_SOURCE.endpointProjectionVersion) {
      throw new Error('HERMES_ENDPOINT_SOURCE_MISMATCH');
    }
    if (projection.status === 'UNAVAILABLE') {
      if (projection.reason !== 'HERMES_ENDPOINT_ID_UNAVAILABLE') throw new Error('HERMES_ENDPOINT_PROJECTION_INVALID');
      return false;
    }
    return projection.providerId === providerId && projection.baseUrlEnvVar === envVar;
  } catch (error) {
    if (error instanceof Error && error.message === 'HERMES_ENDPOINT_SOURCE_MISMATCH') throw error;
    if (error instanceof Error && error.message === 'HERMES_ENDPOINT_PROJECTION_INVALID') throw error;
    return false;
  } finally {
    valueBytes.fill(0);
  }
}

function parseEndpointProjection(output: string): NativeEndpointProjection {
  let parsed: unknown;
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 2_048) throw new Error();
    parsed = JSON.parse(output);
  } catch {
    throw new Error('HERMES_ENDPOINT_PROJECTION_INVALID');
  }
  if (!isRecord(parsed)) throw new Error('HERMES_ENDPOINT_PROJECTION_INVALID');
  const common = ['sourceVersion', 'sourceCommit', 'projectionVersion', 'status'];
  const expected = parsed.status === 'PINNED_DEFAULT'
    ? [...common, 'providerId', 'baseUrlEnvVar']
    : parsed.status === 'UNAVAILABLE'
      ? [...common, 'reason']
      : [];
  if (expected.length === 0 || Object.keys(parsed).length !== expected.length ||
      Object.keys(parsed).some((key) => !expected.includes(key)) ||
      typeof parsed.sourceVersion !== 'string' || typeof parsed.sourceCommit !== 'string' ||
      typeof parsed.projectionVersion !== 'string' ||
      (parsed.status === 'PINNED_DEFAULT' && (typeof parsed.providerId !== 'string' || typeof parsed.baseUrlEnvVar !== 'string')) ||
      (parsed.status === 'UNAVAILABLE' && typeof parsed.reason !== 'string')) {
    throw new Error('HERMES_ENDPOINT_PROJECTION_INVALID');
  }
  return parsed as unknown as NativeEndpointProjection;
}

interface NativeEndpointProjection {
  sourceVersion: string;
  sourceCommit: string;
  projectionVersion: string;
  status: 'PINNED_DEFAULT' | 'UNAVAILABLE';
  providerId?: string;
  baseUrlEnvVar?: string;
  reason?: string;
}

function parseProjection(output: string): NativeSelectionProjection {
  let parsed: unknown;
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 2_048) {
      throw new Error();
    }
    parsed = JSON.parse(output);
  } catch {
    throw new Error('HERMES_SELECTION_PROJECTION_INVALID');
  }
  if (!isRecord(parsed)) throw new Error('HERMES_SELECTION_PROJECTION_INVALID');

  const commonKeys = ['sourceVersion', 'sourceCommit', 'projectionVersion', 'status', 'endpointOverridePresent'];
  const status = parsed.status;
  const expectedKeys = status === 'EXPLICIT_SELECTION'
    ? [...commonKeys, 'providerId', 'modelId']
    : status === 'UNAVAILABLE'
      ? [...commonKeys, 'reason']
      : [];
  if (expectedKeys.length === 0 || Object.keys(parsed).length !== expectedKeys.length ||
      Object.keys(parsed).some((key) => !expectedKeys.includes(key)) ||
      typeof parsed.sourceVersion !== 'string' || typeof parsed.sourceCommit !== 'string' ||
      typeof parsed.projectionVersion !== 'string' || typeof parsed.endpointOverridePresent !== 'boolean' ||
      (status === 'UNAVAILABLE' && typeof parsed.reason !== 'string') ||
      (status === 'EXPLICIT_SELECTION' && (typeof parsed.providerId !== 'string' || typeof parsed.modelId !== 'string'))) {
    throw new Error('HERMES_SELECTION_PROJECTION_INVALID');
  }
  return parsed as unknown as NativeSelectionProjection;
}

function isSafeProviderId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isSafeModelId(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value);
}

function isSafeRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isAbsoluteForPlatform(value: string, platform: 'win32' | 'linux'): boolean {
  return typeof value === 'string' && (platform === 'win32' ? isWindowsAbsolute(value) : isPosixAbsolute(value));
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
