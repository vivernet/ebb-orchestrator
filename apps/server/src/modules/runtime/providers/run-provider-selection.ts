/**
 * Разрешение и валидация durable выбора провайдера/модели/auth-метода/ревизии
 * для Run (plan-24, Task 5).
 *
 * Порядок разрешения: явный Run override → точный дефолт роли → глобальный
 * дефолт. Источник дефолтов — `provider_configurations.model_selection_json`
 * (пары `roleDefaults`/`defaultModelId`). Разрешение детерминировано: скан
 * включённых провайдеров в порядке `provider_id`.
 *
 * Инварианты (fail-closed):
 *  - неизвестный провайдер/auth-метод, отключённый или ненастроенный
 *    провайдер, неизвестная модель, модель без требуемых для роли возможностей
 *    и отсутствующий credential завершаются типизированной ошибкой до dispatch;
 *  - auth-метод обязан быть объявлен в каталоге и совпадать с
 *    `selected_auth_method` ревизии снимка конфигурации (Task 2 repo);
 *  - credential обязателен, кроме auth-методов, явно допускающих работу без
 *    секрета (`local-endpoint`);
 *  - если ни один включённый провайдер не определяет дефолт для роли/глобально,
 *    возвращается `null` — legacy-путь Hermes (существующее поведение).
 */

import { getProvider } from "./provider-catalog.js";
import { getModel } from "./provider-model-catalog.js";
import type { ProviderDefinition } from "./provider-types.js";
import type {
  ProviderConfigurationRecord,
  ProviderCredentialMetadataRecord,
} from "./provider-settings-repository.js";

/** Возможности модели, обязательные для всех ролей оркестратора.
 * Каждая роль работает через контролируемые инструменты (toolCalling) и
 * завершается валидированным структурированным результатом через submit_result
 * (структура результата валидируется серверно, нативная structuredOutput-капабильность
 * провайдера для этого не требуется). */
export const REQUIRED_ROLE_MODEL_CAPABILITIES: readonly string[] = Object.freeze([
  "chat",
  "toolCalling",
]);

/** Auth-методы, которым не требуется секрет (локальные endpoint-провайдеры). */
export const AUTH_METHODS_ALLOWING_NO_SECRET: ReadonlySet<string> = new Set([
  "local-endpoint",
]);

/** Источник разрешённого выбора. */
export type RunProviderSelectionSource = "explicit" | "role-default" | "global-default";

/** Разрешённый и валидированный выбор провайдера для Run. */
export interface ResolvedRunProviderSelection {
  readonly source: RunProviderSelectionSource;
  readonly providerId: string;
  readonly modelId: string;
  readonly authMethodId: string;
  readonly configRevision: number;
}

/** Явный Run override от вызывающего кода (опционален). */
export interface ExplicitProviderSelectionInput {
  readonly providerId: string;
  readonly modelId?: string;
  readonly authMethodId?: string;
}

/**
 * Читатель настроек провайдеров для разрешения. Реализуется поверх
 * `DatabaseTx` или `Database`, чтобы разрешение выполнялось в той же SQLite
 * транзакции, что и создание Run (атомарность против параллельного изменения
 * дефолтов).
 */
export interface ProviderSelectionReader {
  getProviderConfiguration(providerId: string): ProviderConfigurationRecord | undefined;
  listProviderConfigurations(): ProviderConfigurationRecord[];
  getCredentialMetadata(providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined;
}

/** Типизированная fail-closed ошибка разрешения выбора провайдера. */
export class RunProviderSelectionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "RunProviderSelectionError";
    this.code = code;
  }
}

function providerUnknown(providerId: string): never {
  throw new RunProviderSelectionError(
    "RUN_REQUEST_PROVIDER_UNKNOWN",
    `Provider '${providerId}' is unknown`,
  );
}

/** Проверяет известность провайдера по каталогу (без сети). */
function assertProviderDefinition(providerId: string): ProviderDefinition {
  const definition = getProvider(providerId);
  if (!definition) providerUnknown(providerId);
  return definition;
}

/** Проверяет конфигурацию и включённость провайдера. */
function assertEnabledConfiguration(providerId: string, config: ProviderConfigurationRecord | undefined): ProviderConfigurationRecord {
  if (!config) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_PROVIDER_NOT_CONFIGURED",
      `Provider '${providerId}' is not configured`,
    );
  }
  if (!config.enabled) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_PROVIDER_DISABLED",
      `Provider '${providerId}' is disabled`,
    );
  }
  return config;
}

/** Проверяет объявление auth-метода и его совпадение с ревизией снимка. */
function assertAuthMethodBinding(
  definition: ProviderDefinition,
  config: ProviderConfigurationRecord,
  authMethodId: string,
): void {
  if (!definition.authMethods.includes(authMethodId as never)) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_AUTH_METHOD_UNKNOWN",
      `Auth method '${authMethodId}' is not declared for provider '${config.providerId}'`,
    );
  }
  if (authMethodId !== config.selectedAuthMethod) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_AUTH_METHOD_SNAPSHOT_MISMATCH",
      `Auth method '${authMethodId}' does not match the configuration revision snapshot for provider '${config.providerId}'`,
    );
  }
}

/** Проверяет существование модели в каталоге и поддержку возможностей роли. */
function assertModelCapabilities(providerId: string, modelId: string, role: string): void {
  const model = getModel(providerId, modelId);
  if (!model) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_MODEL_UNSUPPORTED",
      `Model '${modelId}' is not in the catalog for provider '${providerId}'`,
    );
  }
  const missing = REQUIRED_ROLE_MODEL_CAPABILITIES.filter(
    (capability) => !model.capabilities.includes(capability as never),
  );
  if (missing.length > 0) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED",
      `Model '${modelId}' of provider '${providerId}' lacks capabilities required for role '${role}': ${missing.join(", ")}`,
    );
  }
}

/** Проверяет наличие активного credential либо явное разрешение работать без секрета. */
function assertCredentialAvailable(
  reader: ProviderSelectionReader,
  providerId: string,
  authMethodId: string,
): void {
  if (AUTH_METHODS_ALLOWING_NO_SECRET.has(authMethodId)) return;
  const credential = reader.getCredentialMetadata(providerId, authMethodId);
  if (!credential || credential.status !== "ACTIVE") {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_PROVIDER_CREDENTIAL_MISSING",
      `No active credential for provider '${providerId}' auth method '${authMethodId}'`,
    );
  }
}

/** Полная валидация кандидата выбора (fail-closed). */
function validateCandidate(
  reader: ProviderSelectionReader,
  providerId: string,
  modelId: string,
  authMethodId: string,
  role: string,
): void {
  const definition = assertProviderDefinition(providerId);
  const config = assertEnabledConfiguration(providerId, reader.getProviderConfiguration(providerId));
  assertAuthMethodBinding(definition, config, authMethodId);
  assertModelCapabilities(providerId, modelId, role);
  assertCredentialAvailable(reader, providerId, authMethodId);
}

/** Возвращает модель дефолта провайдера для роли: дефолт роли → глобальный. */
function defaultModelForRole(config: ProviderConfigurationRecord, role: string): string | undefined {
  const roleDefault = config.modelSelection.roleDefaults[role];
  if (roleDefault !== undefined && roleDefault.length > 0) return roleDefault;
  return config.modelSelection.defaultModelId ?? undefined;
}

/**
 * Разрешает выбор провайдера для Run.
 *
 * @param input Параметры разрешения (объект).
 * @param input.explicit Явный Run override (опционален).
 * @param input.model Caller-модель (`"default"` или явная модель).
 * @param input.role Роль Run, для которой разрешается дефолт.
 * @param reader Читатель настроек (обычно в той же транзакции).
 * @returns Валидированный выбор либо `null`, если применим legacy-путь без
 *          привязки к провайдеру (никаких дефолтов не настроено).
 * @throws {RunProviderSelectionError} При любой fail-closed ошибке валидации.
 */
export function resolveRunProviderSelection(
  input: {
    readonly explicit?: ExplicitProviderSelectionInput;
    readonly model: string;
    readonly role: string;
  },
  reader: ProviderSelectionReader,
): ResolvedRunProviderSelection | null {
  if (input.explicit) {
    return resolveExplicit(input.explicit, input.model, input.role, reader);
  }
  return resolveDefaults(input.model, input.role, reader);
}

function resolveExplicit(
  explicit: ExplicitProviderSelectionInput,
  callerModel: string,
  role: string,
  reader: ProviderSelectionReader,
): ResolvedRunProviderSelection {
  const definition = assertProviderDefinition(explicit.providerId);
  const config = assertEnabledConfiguration(explicit.providerId, reader.getProviderConfiguration(explicit.providerId));
  const authMethodId = explicit.authMethodId ?? config.selectedAuthMethod;
  assertAuthMethodBinding(definition, config, authMethodId);

  const modelId = explicit.modelId ?? (callerModel !== "default" ? callerModel : undefined)
    ?? defaultModelForRole(config, role);
  if (!modelId) {
    throw new RunProviderSelectionError(
      "RUN_REQUEST_MODEL_UNSUPPORTED",
      `No model resolved for provider '${explicit.providerId}' and role '${role}'`,
    );
  }
  validateCandidate(reader, explicit.providerId, modelId, authMethodId, role);
  return {
    source: explicit.modelId !== undefined || callerModel !== "default" ? "explicit" : "role-default",
    providerId: explicit.providerId,
    modelId,
    authMethodId,
    configRevision: config.currentRevision,
  };
}

function resolveDefaults(
  callerModel: string,
  role: string,
  reader: ProviderSelectionReader,
): ResolvedRunProviderSelection | null {
  if (callerModel !== "default") return null;

  const enabled = reader.listProviderConfigurations()
    .filter((config) => config.enabled)
    .sort((left, right) => left.providerId.localeCompare(right.providerId));

  for (const config of enabled) {
    const modelId = defaultModelForRole(config, role);
    if (modelId === undefined) continue;
    // Кандидат существует — любая ошибка валидации завершается fail-closed,
    // а не молчаливым переходом к другому провайдеру/legacy.
    validateCandidate(reader, config.providerId, modelId, config.selectedAuthMethod, role);
    return {
      source: config.modelSelection.roleDefaults[role] !== undefined ? "role-default" : "global-default",
      providerId: config.providerId,
      modelId,
      authMethodId: config.selectedAuthMethod,
      configRevision: config.currentRevision,
    };
  }
  return null;
}
