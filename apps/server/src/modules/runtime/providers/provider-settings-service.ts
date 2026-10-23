/**
 * Сервис настроек AI-провайдеров (plan-24, Task 2).
 *
 * Предоставляет API-контракт верхнего уровня над репозиторием и
 * credential-хранилищем: сохранение настроек без секретов, сохранение
 * credentials (наружу — только метаданные), фиксация Run-selection snapshot и
 * отключение провайдера.
 *
 * Инварианты:
 *  - значения секретов не покидают SecretStore; статусные проекции и результаты
 *    сервиса не содержат ни значений, ни payload-ов credentials;
 *  - неизвестные провайдеры/auth-методы завершаются fail-closed
 *    (`PROVIDER_UNKNOWN` / `AUTH_METHOD_UNKNOWN`) без дефолтных подстановок;
 *  - `disconnectProvider` удаляет локальные credentials и метаданные
 *    транзакционно; удалённый revoke является отдельной операцией (Task 4) и
 *    здесь не выполняется и не заявляется;
 *  - сетевых вызовов к провайдерам сервис не выполняет.
 */

import { getProvider, assertProviderKnown } from "./provider-catalog.js";
import type { ProviderAuthMethod } from "./provider-types.js";
import {
  InvalidProviderConfigurationError,
  ProviderConfigurationMissingError,
  type ProviderConfigurationRecord,
  type ProviderCredentialMetadataRecord,
  type ProviderSettingsRepository,
  type RunProviderSelectionRecord,
} from "./provider-settings-repository.js";
import {
  PROVIDER_CREDENTIAL_SERVICE,
  type ProviderCredentialStore,
} from "./provider-credential-store.js";
import type { SecretStore } from "../../../platform/security/secret-store.js";
import { isSecretStoreUnavailableError } from "../../../platform/security/secret-store.js";
import { ProviderCredentialStoreUnavailableError } from "./provider-credential-store.js";

/** Входные данные частичного сохранения настроек провайдера. */
export interface SaveProviderSettingsInput {
  readonly providerId: string;
  readonly enabled?: boolean;
  readonly selectedAuthMethod?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly modelSelection?: { readonly defaultModelId: string | null; readonly roleDefaults: Readonly<Record<string, string>> };
}

/** Статусная проекция без секретов: только идентичность, состояние и метаданные. */
export interface ProviderStatusProjection {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly selectedAuthMethod: string;
  readonly currentRevision: number;
  readonly hasCredential: boolean;
  readonly credentialStatus: "ACTIVE" | "DISCONNECTED" | "NONE";
  readonly defaultModelId: string | null;
  readonly roleDefaults: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Результат отключения провайдера. */
export interface ProviderDisconnectResult {
  readonly providerId: string;
  readonly localDisconnected: true;
  /** Удалённый revoke не выполняется сервисом; задача Task 4 отдельная. */
  readonly remoteRevoke: "NOT_ATTEMPTED";
  readonly revokedCredentialRefs: readonly string[];
}

/**
 * Сервис настроек провайдеров: валидация по каталогу (без сети), делегирование
 * репозиторию и credential-хранилищу.
 */
export class ProviderSettingsService {
  public constructor(
    private readonly repository: ProviderSettingsRepository,
    private readonly credentialStore: ProviderCredentialStore,
    private readonly secretStore: SecretStore,
  ) {}

  /** Проверяет, что auth-метод объявлен в каталоге провайдера. */
  private assertAuthMethodKnown(providerId: string, authMethodId: string): void {
    const definition = getProvider(providerId);
    const known = definition?.authMethods.includes(authMethodId as ProviderAuthMethod);
    if (!definition || !known) {
      throw new Error(`AUTH_METHOD_UNKNOWN: ${providerId}/${authMethodId}`);
    }
  }

  /**
   * Сохраняет настройки провайдера (частичное обновление при существующей
   * записи). Идентичная запись не меняет ревизию (идемпотентность).
   */
  saveSettings(input: SaveProviderSettingsInput): ProviderConfigurationRecord {
    if (input.providerId.length === 0) {
      throw new InvalidProviderConfigurationError("Provider id must not be empty");
    }
    assertProviderKnown(input.providerId);
    if (input.selectedAuthMethod !== undefined) {
      this.assertAuthMethodKnown(input.providerId, input.selectedAuthMethod);
    }
    const existing = this.repository.getProviderConfiguration(input.providerId);
    if (existing) {
      return this.repository.saveProviderConfiguration({
        providerId: input.providerId,
        enabled: input.enabled ?? existing.enabled,
        selectedAuthMethod: input.selectedAuthMethod ?? existing.selectedAuthMethod,
        config: input.config ?? existing.config,
        modelSelection: input.modelSelection ?? existing.modelSelection,
      });
    }

    // Первичное сохранение требует явных значений: без «дефолтных» подстановок.
    if (input.enabled === undefined || input.selectedAuthMethod === undefined || input.config === undefined || input.modelSelection === undefined) {
      throw new InvalidProviderConfigurationError("Initial provider save requires enabled, selectedAuthMethod, config and modelSelection");
    }
    if (input.enabled) {
      this.assertAuthMethodKnown(input.providerId, input.selectedAuthMethod);
    }
    return this.repository.saveProviderConfiguration({
      providerId: input.providerId,
      enabled: input.enabled,
      selectedAuthMethod: input.selectedAuthMethod,
      config: input.config,
      modelSelection: input.modelSelection,
    });
  }

  /** Возвращает конфигурацию провайдера (несекретные настройки). */
  getSettings(providerId: string): ProviderConfigurationRecord | undefined {
    return this.repository.getProviderConfiguration(providerId);
  }

  /** Возвращает все сохранённые конфигурации. */
  listSettings(): ProviderConfigurationRecord[] {
    return this.repository.listProviderConfigurations();
  }

  /** Возвращает immutable-снимок указанной ревизии конфигурации. */
  getConfigSnapshot(providerId: string, revision: number) {
    return this.repository.getConfigSnapshot(providerId, revision);
  }

  /**
   * Сохраняет credentials провайдера через SecretStore; наружу возвращаются
   * только метаданные.
   */
  async saveCredential(
    providerId: string,
    authMethodId: string,
    payload: Readonly<Record<string, string>>,
  ) {
    const definition = getProvider(providerId);
    if (!definition) {
      throw new Error("PROVIDER_UNKNOWN");
    }
    this.assertAuthMethodKnown(providerId, authMethodId);
    const allowedFields = new Set(definition.credentialSchema.fields.map((field) => field.name));
    for (const key of Object.keys(payload)) {
      if (!allowedFields.has(key)) {
        throw new InvalidProviderConfigurationError(`Credential field '${key}' is not declared for provider '${providerId}'`);
      }
    }
    return this.credentialStore.saveCredential(providerId, authMethodId, payload);
  }

  /**
   * Фиксирует Run-selection snapshot: точная привязка провайдера/модели/auth-
   * метода/ревизии до dispatch. Неизвестная ревизия завершается fail-closed.
   */
  createRunSelection(runId: string, selection: {
    readonly providerId: string;
    readonly modelId: string;
    readonly authMethodId: string;
    readonly configRevision: number;
  }): RunProviderSelectionRecord {
    const definition = getProvider(selection.providerId);
    if (!definition) throw new Error("PROVIDER_UNKNOWN");
    this.assertAuthMethodKnown(selection.providerId, selection.authMethodId);
    if (selection.modelId.length === 0) {
      throw new InvalidProviderConfigurationError("Model id must not be empty");
    }
    if (!Number.isSafeInteger(selection.configRevision) || selection.configRevision < 1) {
      throw new InvalidProviderConfigurationError("Config revision must be a positive integer");
    }
    return this.repository.createRunSelection({
      runId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      authMethodId: selection.authMethodId,
      configRevision: selection.configRevision,
    });
  }

  /** Возвращает зафиксированный Run-selection snapshot. */
  getRunSelection(runId: string): RunProviderSelectionRecord | undefined {
    return this.repository.getRunSelection(runId);
  }

  /**
   * Отключает провайдера: удаляет локальные credentials (keyring) и метаданные
   * транзакционно. Remote revoke отдельно не выполняется и не заявляется.
   */
  async disconnectProvider(providerId: string): Promise<ProviderDisconnectResult> {
    if (!this.repository.getProviderConfiguration(providerId)) {
      throw new ProviderConfigurationMissingError(providerId);
    }
    const credentials = this.repository.listCredentialMetadata(providerId);

    // Фаза 1: отзыв записей keyring до изменения БД. Сбой останавливает
    // операцию: БД остаётся согласованной (fail-closed).
    const revokedRefs: string[] = [];
    for (const credential of credentials) {
      try {
        await this.secretStore.revoke(PROVIDER_CREDENTIAL_SERVICE, credential.secretName);
      } catch (error) {
        if (isSecretStoreUnavailableError(error)) {
          throw new ProviderCredentialStoreUnavailableError();
        }
        throw error;
      }
      revokedRefs.push(credential.referenceId);
    }

    // Фаза 2: транзакционное удаление метаданных и конфигурации.
    this.repository.removeCredentialMetadataForProvider(providerId);
    this.repository.deleteProviderConfiguration(providerId);

    return {
      providerId,
      localDisconnected: true,
      remoteRevoke: "NOT_ATTEMPTED",
      revokedCredentialRefs: revokedRefs,
    };
  }

  /** Статусная проекция без секретов для одного провайдера. */
  getProviderStatus(providerId: string): ProviderStatusProjection | undefined {
    const configuration = this.repository.getProviderConfiguration(providerId);
    if (!configuration) return undefined;
    return this.projectStatus(configuration);
  }

  /** Статусные проекции всех провайдеров без секретов. */
  listProviderStatuses(): ProviderStatusProjection[] {
    return this.repository.listProviderConfigurations().map((configuration) => this.projectStatus(configuration));
  }

  private projectStatus(configuration: ProviderConfigurationRecord): ProviderStatusProjection {
    const credential = this.repository.getCredentialMetadata(configuration.providerId, configuration.selectedAuthMethod);
    const credentialStatus: ProviderStatusProjection["credentialStatus"] = credential ? credential.status : "NONE";
    return {
      providerId: configuration.providerId,
      enabled: configuration.enabled,
      selectedAuthMethod: configuration.selectedAuthMethod,
      currentRevision: configuration.currentRevision,
      hasCredential: credential !== undefined,
      credentialStatus,
      defaultModelId: configuration.modelSelection.defaultModelId,
      roleDefaults: configuration.modelSelection.roleDefaults,
      createdAt: configuration.createdAt,
      updatedAt: configuration.updatedAt,
    };
  }
}

/** Создаёт сервис настроек провайдеров поверх репозитория, credential-хранилища и SecretStore. */
export function createProviderSettingsService(
  repository: ProviderSettingsRepository,
  credentialStore: ProviderCredentialStore,
  secretStore: SecretStore,
): ProviderSettingsService {
  return new ProviderSettingsService(repository, credentialStore, secretStore);
}

/** Тип метаданных credential для потребителей сервиса. */
export type { ProviderCredentialMetadataRecord };
