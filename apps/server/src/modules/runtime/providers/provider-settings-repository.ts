/**
 * SQLite-репозиторий настроек AI-провайдеров (plan-24, Task 2).
 *
 * Хранит несекретные настройки, версионированные снимки конфигурации и
 * метаданные credentials (opaque references). Значения секретов в SQLite
 * никогда не записываются — только ссылки на OS SecretStore.
 *
 * Инварианты:
 *  - транзакционная запись: конфигурация и снимок новой ревизии создаются в
 *    одной транзакции; сбой не оставляет частичных изменений;
 *  - идемпотентность: повторное сохранение идентичной конфигурации не создаёт
 *    новую ревизию и не меняет строки;
 *  - ревизии: configRevision инкрементируется при изменении конфигурации;
 *    старые ревизии сохраняются в provider_config_snapshots и не мутируются;
 *  - fail-closed: неизвестный провайдер/снимок/Reference завершается ошибкой,
 *    а не «дефолтным» значением.
 */

import type { Database, DatabaseTx } from "../../../platform/database/database.js";

/** Ошибка: конфигурация провайдера не найдена. */
export class ProviderConfigurationMissingError extends Error {
  public constructor(providerId: string) {
    super(`Provider configuration for provider '${providerId}' is missing`);
    this.name = "ProviderConfigurationMissingError";
  }
}

/** Ошибка: запрошенная ревизия снимка конфигурации не существует. */
export class ProviderConfigSnapshotUnknownError extends Error {
  public constructor(providerId: string, revision: number) {
    super(`Provider config snapshot ${revision} for provider '${providerId}' does not exist`);
    this.name = "ProviderConfigSnapshotUnknownError";
  }
}

/** Ошибка: Run-selection immutable; повторное создание для того же Run запрещено. */
export class RunSelectionImmutableError extends Error {
  public constructor(runId: string) {
    super(`Run provider selection for run '${runId}' is immutable`);
    this.name = "RunSelectionImmutableError";
  }
}

/** Ошибка: невалидная структура несекретной конфигурации. */
export class InvalidProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidProviderConfigurationError";
  }
}

/** Модельные предпочтения: глобальный дефолт и дефолты по ролям (global/role preference). */
export interface ModelSelectionConfig {
  /** Модель по умолчанию (глобальный приоритет). */
  readonly defaultModelId: string | null;
  /** Модель по умолчанию для конкретной роли; приоритет выше глобального. */
  readonly roleDefaults: Readonly<Record<string, string>>;
}

/** Входные данные сохранения конфигурации провайдера. */
export interface SaveProviderConfigurationInput {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly selectedAuthMethod: string;
  /** Несекретные настройки (включая endpoint-поля по схеме провайдера). */
  readonly config: Readonly<Record<string, unknown>>;
  readonly modelSelection: ModelSelectionConfig;
}

/** Запись конфигурации провайдера без секретных значений. */
export interface ProviderConfigurationRecord {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly selectedAuthMethod: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly modelSelection: ModelSelectionConfig;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Снимок одной ревизии конфигурации провайдера (immutable после записи). */
export interface ProviderConfigSnapshotRecord {
  readonly providerId: string;
  readonly revision: number;
  readonly selectedAuthMethod: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly modelSelection: ModelSelectionConfig;
  readonly capturedAt: string;
}

/** Метаданные credential-записи провайдера: только ссылки и статус, без значений. */
export interface ProviderCredentialMetadataRecord {
  readonly providerId: string;
  readonly authMethodId: string;
  readonly secretName: string;
  readonly referenceId: string;
  readonly status: "ACTIVE" | "DISCONNECTED";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Запись выбора провайдера/модели/auth-метода/ревизии для Run (потребляет Task 5). */
export interface RunProviderSelectionRecord {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly authMethodId: string;
  readonly configRevision: number;
  readonly createdAt: string;
}

/** Входные данные создания Run-selection snapshot. */
export interface CreateRunSelectionInput {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly authMethodId: string;
  readonly configRevision: number;
}

/** Входные данные прикрепления метаданных credential-записи. */
export interface AttachCredentialMetadataInput {
  readonly providerId: string;
  readonly authMethodId: string;
  readonly secretName: string;
  readonly referenceId: string;
  readonly status: "ACTIVE" | "DISCONNECTED";
  readonly now: string;
}

/** Контракт репозитория настроек провайдеров. */
export interface ProviderSettingsRepository {
  saveProviderConfiguration(input: SaveProviderConfigurationInput): ProviderConfigurationRecord;
  getProviderConfiguration(providerId: string): ProviderConfigurationRecord | undefined;
  listProviderConfigurations(): ProviderConfigurationRecord[];
  getConfigSnapshot(providerId: string, revision: number): ProviderConfigSnapshotRecord | undefined;
  attachCredentialMetadata(input: AttachCredentialMetadataInput): ProviderCredentialMetadataRecord;
  getCredentialMetadata(providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined;
  listCredentialMetadata(providerId?: string): ProviderCredentialMetadataRecord[];
  removeCredentialMetadata(providerId: string, authMethodId: string): boolean;
  removeCredentialMetadataForProvider(providerId: string): number;
  deleteProviderConfiguration(providerId: string): boolean;
  createRunSelection(input: CreateRunSelectionInput): RunProviderSelectionRecord;
  getRunSelection(runId: string): RunProviderSelectionRecord | undefined;
  /**
   * Транзакционные чтения/запись для Task 5: разрешение и фиксация выбора
   * провайдера выполняются в той же SQLite транзакции, что и создание Run,
   * чтобы изменение дефолтов между preflight и dispatch не создавало окна.
   */
  getProviderConfigurationTx(tx: DatabaseTx, providerId: string): ProviderConfigurationRecord | undefined;
  listProviderConfigurationsTx(tx: DatabaseTx): ProviderConfigurationRecord[];
  getCredentialMetadataTx(tx: DatabaseTx, providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined;
  createRunSelectionTx(tx: DatabaseTx, input: CreateRunSelectionInput): RunProviderSelectionRecord;
}

type ConfigurationRow = {
  provider_id: string;
  enabled: number;
  selected_auth_method: string;
  config_json: string;
  model_selection_json: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
};

type SnapshotRow = {
  provider_id: string;
  revision: number;
  selected_auth_method: string;
  config_json: string;
  model_selection_json: string;
  captured_at: string;
};

type CredentialRow = {
  provider_id: string;
  auth_method_id: string;
  secret_name: string;
  reference_id: string;
  status: "ACTIVE" | "DISCONNECTED";
  created_at: string;
  updated_at: string;
};

type SelectionRow = {
  run_id: string;
  provider_id: string;
  model_id: string;
  auth_method_id: string;
  config_revision: number;
  created_at: string;
};

/** Входные данные вставки снимка: уже сериализованные JSON-строки. */
type SnapshotSeed = {
  providerId: string;
  revision: number;
  selectedAuthMethod: string;
  configJson: string;
  modelSelectionJson: string;
  capturedAt: string;
};

/** Проверяет, что значение — плоский JSON-объект (не массив и не null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Канонизирует и валидирует несекретную конфигурацию провайдера. */
function normalizeConfig(config: Readonly<Record<string, unknown>>): string {
  if (!isPlainRecord(config)) {
    throw new InvalidProviderConfigurationError("Provider config must be a plain object");
  }
  const json = JSON.stringify(config);
  if (json === undefined) throw new InvalidProviderConfigurationError("Provider config is not JSON-serializable");
  if (json.length > 64 * 1024) throw new InvalidProviderConfigurationError("Provider config exceeds 64 KiB");
  return json;
}

/** Канонизирует и валидирует модельные предпочтения. */
function normalizeModelSelection(modelSelection: ModelSelectionConfig): string {
  const { defaultModelId, roleDefaults } = modelSelection;
  if (defaultModelId !== null && typeof defaultModelId !== "string") {
    throw new InvalidProviderConfigurationError("defaultModelId must be a string or null");
  }
  if (!isPlainRecord(roleDefaults)) {
    throw new InvalidProviderConfigurationError("roleDefaults must be a plain object");
  }
  const normalizedDefaults: Record<string, string> = {};
  for (const [role, modelId] of Object.entries(roleDefaults)) {
    if (role.length === 0) throw new InvalidProviderConfigurationError("Role name must not be empty");
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new InvalidProviderConfigurationError(`Model for role '${role}' must be a non-empty string`);
    }
    normalizedDefaults[role] = modelId;
  }
  const json = JSON.stringify({ defaultModelId, roleDefaults: normalizedDefaults });
  if (json.length > 16 * 1024) throw new InvalidProviderConfigurationError("Model selection exceeds 16 KiB");
  return json;
}

/** Проверяет, что сохранённая JSON-строка — плоский объект (защита от повреждённых строк). */
function assertStoredObjectJson(json: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidProviderConfigurationError(`Stored ${label} is not valid JSON`);
  }
  if (!isPlainRecord(parsed)) throw new InvalidProviderConfigurationError(`Stored ${label} is not a plain object`);
  return parsed;
}

function parseModelSelection(json: string): ModelSelectionConfig {
  const parsed = assertStoredObjectJson(json, "model selection");
  const defaultModelId = parsed.defaultModelId === null ? null : parsed.defaultModelId;
  if (typeof defaultModelId !== "string" && defaultModelId !== null) {
    throw new InvalidProviderConfigurationError("Stored model selection has invalid defaultModelId");
  }
  const roleDefaults = parsed.roleDefaults;
  if (!isPlainRecord(roleDefaults)) {
    throw new InvalidProviderConfigurationError("Stored model selection has invalid roleDefaults");
  }
  const normalized: Record<string, string> = {};
  for (const [role, modelId] of Object.entries(roleDefaults)) {
    if (typeof modelId !== "string") {
      throw new InvalidProviderConfigurationError("Stored model selection has non-string role model");
    }
    normalized[role] = modelId;
  }
  return { defaultModelId, roleDefaults: normalized };
}

function toConfigurationRecord(row: ConfigurationRow): ProviderConfigurationRecord {
  return {
    providerId: row.provider_id,
    enabled: row.enabled === 1,
    selectedAuthMethod: row.selected_auth_method,
    config: assertStoredObjectJson(row.config_json, "config"),
    modelSelection: parseModelSelection(row.model_selection_json),
    currentRevision: row.current_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSnapshotRecord(row: SnapshotRow): ProviderConfigSnapshotRecord {
  return {
    providerId: row.provider_id,
    revision: row.revision,
    selectedAuthMethod: row.selected_auth_method,
    config: assertStoredObjectJson(row.config_json, "config"),
    modelSelection: parseModelSelection(row.model_selection_json),
    capturedAt: row.captured_at,
  };
}

function toCredentialRecord(row: CredentialRow): ProviderCredentialMetadataRecord {
  return {
    providerId: row.provider_id,
    authMethodId: row.auth_method_id,
    secretName: row.secret_name,
    referenceId: row.reference_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSelectionRecord(row: SelectionRow): RunProviderSelectionRecord {
  return {
    runId: row.run_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    authMethodId: row.auth_method_id,
    configRevision: row.config_revision,
    createdAt: row.created_at,
  };
}

function readConfigurationRow(tx: DatabaseTx, providerId: string): ConfigurationRow | undefined {
  return tx.get<ConfigurationRow>(
    "SELECT provider_id, enabled, selected_auth_method, config_json, model_selection_json, current_revision, created_at, updated_at FROM provider_configurations WHERE provider_id = $providerId",
    { providerId },
  );
}

function insertSnapshot(tx: DatabaseTx, seed: SnapshotSeed): void {
  tx.run(
    `INSERT INTO provider_config_snapshots(provider_id, revision, selected_auth_method, config_json, model_selection_json, captured_at)
     VALUES($providerId, $revision, $selectedAuthMethod, $configJson, $modelSelectionJson, $capturedAt)`,
    {
      providerId: seed.providerId,
      revision: seed.revision,
      selectedAuthMethod: seed.selectedAuthMethod,
      configJson: seed.configJson,
      modelSelectionJson: seed.modelSelectionJson,
      capturedAt: seed.capturedAt,
    },
  );
}

/**
 * SQLite-адаптер репозитория настроек провайдеров.
 * Все мутации выполняются в транзакциях `BEGIN IMMEDIATE`.
 */
export class SqliteProviderSettingsRepository implements ProviderSettingsRepository {
  public constructor(private readonly database: Database) {}

  /** Сохраняет конфигурацию провайдера; идентичная запись снова не меняет ревизию. */
  saveProviderConfiguration(input: SaveProviderConfigurationInput): ProviderConfigurationRecord {
    if (input.providerId.length === 0) throw new InvalidProviderConfigurationError("Provider id must not be empty");
    if (input.selectedAuthMethod.length === 0) throw new InvalidProviderConfigurationError("Auth method must not be empty");
    const configJson = normalizeConfig(input.config);
    const modelSelectionJson = normalizeModelSelection(input.modelSelection);

    return this.database.transaction((tx) => {
      const existing = readConfigurationRow(tx, input.providerId);
      if (!existing) {
        const now = new Date().toISOString();
        tx.run(
          `INSERT INTO provider_configurations(provider_id, enabled, selected_auth_method, config_json, model_selection_json, current_revision, created_at, updated_at)
           VALUES($providerId, $enabled, $selectedAuthMethod, $configJson, $modelSelectionJson, 1, $now, $now)`,
          {
            providerId: input.providerId,
            enabled: input.enabled ? 1 : 0,
            selectedAuthMethod: input.selectedAuthMethod,
            configJson,
            modelSelectionJson,
            now,
          },
        );
        insertSnapshot(tx, {
          providerId: input.providerId,
          revision: 1,
          selectedAuthMethod: input.selectedAuthMethod,
          configJson,
          modelSelectionJson,
          capturedAt: now,
        });
        const row = readConfigurationRow(tx, input.providerId);
        if (!row) throw new Error("Provider configuration insert returned no row");
        return toConfigurationRecord(row);
      }

      const enabledSame = existing.enabled === (input.enabled ? 1 : 0);
      const contentSame = enabledSame
        && existing.selected_auth_method === input.selectedAuthMethod
        && existing.config_json === configJson
        && existing.model_selection_json === modelSelectionJson;
      if (contentSame) return toConfigurationRecord(existing);

      const nextRevision = existing.current_revision + 1;
      const now = new Date().toISOString();
      tx.run(
        `UPDATE provider_configurations
            SET enabled = $enabled, selected_auth_method = $selectedAuthMethod, config_json = $configJson,
                model_selection_json = $modelSelectionJson, current_revision = $revision, updated_at = $now
          WHERE provider_id = $providerId`,
        {
          providerId: input.providerId,
          enabled: input.enabled ? 1 : 0,
          selectedAuthMethod: input.selectedAuthMethod,
          configJson,
          modelSelectionJson,
          revision: nextRevision,
          now,
        },
      );
      insertSnapshot(tx, {
        providerId: input.providerId,
        revision: nextRevision,
        selectedAuthMethod: input.selectedAuthMethod,
        configJson,
        modelSelectionJson,
        capturedAt: now,
      });
      const updated = readConfigurationRow(tx, input.providerId);
      if (!updated) throw new Error("Provider configuration update returned no row");
      return toConfigurationRecord(updated);
    });
  }

  /** Возвращает конфигурацию провайдера или undefined для неизвестного id. */
  getProviderConfiguration(providerId: string): ProviderConfigurationRecord | undefined {
    return this.getProviderConfigurationTx(this.database, providerId);
  }

  /** Возвращает конфигурацию провайдера в заданной транзакции. */
  getProviderConfigurationTx(tx: DatabaseTx, providerId: string): ProviderConfigurationRecord | undefined {
    const row = readConfigurationRow(tx, providerId);
    return row ? toConfigurationRecord(row) : undefined;
  }

  /** Возвращает все сохранённые конфигурации без секретных значений. */
  listProviderConfigurations(): ProviderConfigurationRecord[] {
    return this.listProviderConfigurationsTx(this.database);
  }

  /** Возвращает все сохранённые конфигурации в заданной транзакции. */
  listProviderConfigurationsTx(tx: DatabaseTx): ProviderConfigurationRecord[] {
    return tx.all<ConfigurationRow>(
      "SELECT provider_id, enabled, selected_auth_method, config_json, model_selection_json, current_revision, created_at, updated_at FROM provider_configurations ORDER BY provider_id",
    ).map(toConfigurationRecord);
  }

  /** Возвращает снимок указанной ревизии конфигурации (immutable). */
  getConfigSnapshot(providerId: string, revision: number): ProviderConfigSnapshotRecord | undefined {
    const row = this.database.get<SnapshotRow>(
      `SELECT provider_id, revision, selected_auth_method, config_json, model_selection_json, captured_at
         FROM provider_config_snapshots WHERE provider_id = $providerId AND revision = $revision`,
      { providerId, revision },
    );
    return row ? toSnapshotRecord(row) : undefined;
  }

  /** Прикрепляет/обновляет метаданные credential-записи (upsert по провайдеру/auth-методу). */
  attachCredentialMetadata(input: AttachCredentialMetadataInput): ProviderCredentialMetadataRecord {
    if (input.secretName.length === 0 || input.referenceId.length === 0) {
      throw new Error("Credential secret name and reference id must not be empty");
    }
    this.database.transaction((tx) => {
      tx.run(
        `INSERT INTO provider_credentials(provider_id, auth_method_id, secret_name, reference_id, status, created_at, updated_at)
         VALUES($providerId, $authMethodId, $secretName, $referenceId, $status, $now, $now)
         ON CONFLICT(provider_id, auth_method_id) DO UPDATE SET
           secret_name = excluded.secret_name,
           reference_id = excluded.reference_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        {
          providerId: input.providerId,
          authMethodId: input.authMethodId,
          secretName: input.secretName,
          referenceId: input.referenceId,
          status: input.status,
          now: input.now,
        },
      );
    });
    const row = this.database.get<CredentialRow>(
      "SELECT provider_id, auth_method_id, secret_name, reference_id, status, created_at, updated_at FROM provider_credentials WHERE provider_id = $providerId AND auth_method_id = $authMethodId",
      { providerId: input.providerId, authMethodId: input.authMethodId },
    );
    if (!row) throw new Error("Credential metadata attach returned no row");
    return toCredentialRecord(row);
  }

  /** Возвращает метаданные credential-записи или undefined, если записи нет. */
  getCredentialMetadata(providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined {
    return this.getCredentialMetadataTx(this.database, providerId, authMethodId);
  }

  /** Возвращает метаданные credential-записи в заданной транзакции. */
  getCredentialMetadataTx(tx: DatabaseTx, providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined {
    const row = tx.get<CredentialRow>(
      "SELECT provider_id, auth_method_id, secret_name, reference_id, status, created_at, updated_at FROM provider_credentials WHERE provider_id = $providerId AND auth_method_id = $authMethodId",
      { providerId, authMethodId },
    );
    return row ? toCredentialRecord(row) : undefined;
  }

  /** Возвращает метаданные credentials провайдера (или всех провайдеров). */
  listCredentialMetadata(providerId?: string): ProviderCredentialMetadataRecord[] {
    const rows = providerId === undefined
      ? this.database.all<CredentialRow>(
          "SELECT provider_id, auth_method_id, secret_name, reference_id, status, created_at, updated_at FROM provider_credentials ORDER BY provider_id, auth_method_id",
        )
      : this.database.all<CredentialRow>(
          "SELECT provider_id, auth_method_id, secret_name, reference_id, status, created_at, updated_at FROM provider_credentials WHERE provider_id = $providerId ORDER BY auth_method_id",
          { providerId },
        );
    return rows.map(toCredentialRecord);
  }

  /** Удаляет метаданные одной credential-записи; возвращает true, если строка существовала. */
  removeCredentialMetadata(providerId: string, authMethodId: string): boolean {
    return this.database.transaction((tx) => {
      tx.run(
        "DELETE FROM provider_credentials WHERE provider_id = $providerId AND auth_method_id = $authMethodId",
        { providerId, authMethodId },
      );
      return Number(tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
    });
  }

  /** Удаляет все метаданные credentials провайдера; возвращает число удалённых строк. */
  removeCredentialMetadataForProvider(providerId: string): number {
    return this.database.transaction((tx) => {
      tx.run("DELETE FROM provider_credentials WHERE provider_id = $providerId", { providerId });
      return Number(tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0);
    });
  }

  /** Удаляет конфигурацию провайдера (каскадно — снимки и метаданные credentials). */
  deleteProviderConfiguration(providerId: string): boolean {
    return this.database.transaction((tx) => {
      tx.run("DELETE FROM provider_configurations WHERE provider_id = $providerId", { providerId });
      return Number(tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) > 0;
    });
  }

  /** Создаёт Run-selection snapshot; требование — существование снимка ревизии (fail-closed). */
  createRunSelection(input: CreateRunSelectionInput): RunProviderSelectionRecord {
    return this.database.transaction((tx) => this.createRunSelectionTx(tx, input));
  }

  /** Создаёт Run-selection snapshot в заданной транзакции (Task 5: одна транзакция с Run). */
  createRunSelectionTx(tx: DatabaseTx, input: CreateRunSelectionInput): RunProviderSelectionRecord {
    if (input.runId.length === 0 || input.modelId.length === 0 || input.authMethodId.length === 0) {
      throw new Error("Run selection fields must not be empty");
    }
    if (!readConfigurationRow(tx, input.providerId)) {
      throw new ProviderConfigurationMissingError(input.providerId);
    }
    const snapshotExists = tx.get<{ one: number }>(
      "SELECT 1 AS one FROM provider_config_snapshots WHERE provider_id = $providerId AND revision = $revision",
      { providerId: input.providerId, revision: input.configRevision },
    );
    if (!snapshotExists) {
      throw new ProviderConfigSnapshotUnknownError(input.providerId, input.configRevision);
    }
    const snapshot = tx.get<SnapshotRow>(
      "SELECT provider_id, revision, selected_auth_method, config_json, model_selection_json, captured_at FROM provider_config_snapshots WHERE provider_id = $providerId AND revision = $revision",
      { providerId: input.providerId, revision: input.configRevision },
    );
    if (snapshot && snapshot.selected_auth_method !== input.authMethodId) {
      throw new InvalidProviderConfigurationError(
        `Run selection auth method '${input.authMethodId}' does not match snapshot revision ${input.configRevision}`,
      );
    }
    const now = new Date().toISOString();
    try {
      tx.run(
        `INSERT INTO run_provider_selections(run_id, provider_id, model_id, auth_method_id, config_revision, created_at)
         VALUES($runId, $providerId, $modelId, $authMethodId, $configRevision, $now)`,
        {
          runId: input.runId,
          providerId: input.providerId,
          modelId: input.modelId,
          authMethodId: input.authMethodId,
          configRevision: input.configRevision,
          now,
        },
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) {
        throw new RunSelectionImmutableError(input.runId);
      }
      throw error;
    }
    const row = tx.get<SelectionRow>(
      "SELECT run_id, provider_id, model_id, auth_method_id, config_revision, created_at FROM run_provider_selections WHERE run_id = $runId",
      { runId: input.runId },
    );
    if (!row) throw new Error("Run selection insert returned no row");
    return toSelectionRecord(row);
  }

  /** Возвращает зафиксированный выбор для Run или undefined. */
  getRunSelection(runId: string): RunProviderSelectionRecord | undefined {
    const row = this.database.get<SelectionRow>(
      "SELECT run_id, provider_id, model_id, auth_method_id, config_revision, created_at FROM run_provider_selections WHERE run_id = $runId",
      { runId },
    );
    return row ? toSelectionRecord(row) : undefined;
  }
}

/** Создаёт единственный SQLite-адаптер репозитория настроек провайдеров. */
export function createProviderSettingsRepository(database: Database): ProviderSettingsRepository {
  return new SqliteProviderSettingsRepository(database);
}
