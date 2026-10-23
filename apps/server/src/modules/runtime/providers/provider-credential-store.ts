/**
 * Credential-хранилище провайдеров (plan-24, Task 2).
 *
 * Оборачивает существующий OS SecretStore (service `ai-provider`) для
 * ограниченных по размеру payload-ов credentials. SQLite не получает значения:
 * только стабильное opaque имя записи и reference на метаданные.
 *
 * Инварианты:
 *  - `resolveCredentialForRun` возвращает секретные байты только для точной
 *    ревизии снимка конфигурации; неизвестная/устаревшая ревизия, отсутствующий
 *    провайдер/auth-метод или недоступный keyring завершаются fail-closed без
 *    plaintext fallback;
 *  - внутренние буферы с секретным значением обнуляются после копирования наружу;
 *    вызывающий код владеет возвращёнными байтами и обязан обнулить их после
 *    использования (см. `zeroBuffer`);
 *  - ротация заменяет запись keyring атомарно (та же opaque-запись); при сбое
 *    метаданных запись keyring отзывается, чтобы БД и keyring остались
 *    согласованными.
 */

import { Buffer } from "node:buffer";
import type { SecretStore } from "../../../platform/security/secret-store.js";
import { isSecretStoreUnavailableError } from "../../../platform/security/secret-store.js";
import {
  ProviderConfigSnapshotUnknownError,
  ProviderConfigurationMissingError,
  type ProviderCredentialMetadataRecord,
  type ProviderSettingsRepository,
} from "./provider-settings-repository.js";

/** Service-имя записи credentials в OS SecretStore. */
export const PROVIDER_CREDENTIAL_SERVICE = "ai-provider" as const;

/** Максимальный размер payload credentials в байтах (JSON). */
export const MAX_CREDENTIAL_PAYLOAD_BYTES = 16 * 1024;

/** Ошибка: keyring недоступен; операция завершается fail-closed, без fallback. */
export class ProviderCredentialStoreUnavailableError extends Error {
  public constructor() {
    super("Provider credential storage is unavailable");
    this.name = "ProviderCredentialStoreUnavailableError";
  }
}

/** Ошибка: запрошенный credential/ревизия отсутствует или не применим. */
export class ProviderCredentialMissingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderCredentialMissingError";
  }
}

/** Результат сохранения credentials: только метаданные, без значений. */
export interface CredentialSaveResult {
  readonly providerId: string;
  readonly authMethodId: string;
  readonly secretName: string;
  readonly referenceId: string;
  readonly status: "ACTIVE" | "DISCONNECTED";
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Обнуляет буфер с секретными байтами после использования. */
export function zeroBuffer(buffer: Uint8Array): void {
  buffer.fill(0);
}

/** Строит стабильное opaque имя записи в SecretStore для пары (провайдер, auth-метод). */
export function credentialSecretName(providerId: string, authMethodId: string): string {
  return `prov:${providerId}:${authMethodId}`;
}

/** Проверяет и сериализует ограниченный payload credentials. */
function encodeCredentialPayload(payload: Readonly<Record<string, string>>): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderCredentialMissingError("Credential payload must be a plain object");
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) throw new ProviderCredentialMissingError("Credential payload must not be empty");
  for (const key of keys) {
    if (key.length === 0 || key.length > 128) {
      throw new ProviderCredentialMissingError("Credential field name has invalid length");
    }
    const value = payload[key];
    if (typeof value !== "string") {
      throw new ProviderCredentialMissingError(`Credential field '${key}' must be a string`);
    }
  }
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_CREDENTIAL_PAYLOAD_BYTES) {
    throw new ProviderCredentialMissingError("Credential payload exceeds size limit");
  }
  return encoded;
}

/**
 * Хранилище credentials провайдеров поверх OS SecretStore.
 * Все ключи keyring живут под service `ai-provider` со стабильными именами.
 */
export class ProviderCredentialStore {
  public constructor(
    private readonly secretStore: SecretStore,
    private readonly repository: ProviderSettingsRepository,
  ) {}

  /**
   * Сохраняет/заменяет payload credentials провайдера.
   * Наружу возвращаются только метаданные; значения не покидают SecretStore.
   */
  async saveCredential(
    providerId: string,
    authMethodId: string,
    payload: Readonly<Record<string, string>>,
  ): Promise<CredentialSaveResult> {
    if (!this.repository.getProviderConfiguration(providerId)) {
      throw new ProviderConfigurationMissingError(providerId);
    }
    const secretName = credentialSecretName(providerId, authMethodId);
    const encoded = encodeCredentialPayload(payload);

    let storeResult: { id: string; service: string; name: string };
    try {
      storeResult = await this.secretStore.store(PROVIDER_CREDENTIAL_SERVICE, secretName, encoded);
    } catch (error) {
      if (isSecretStoreUnavailableError(error)) {
        throw new ProviderCredentialStoreUnavailableError();
      }
      throw error;
    }

    try {
      const metadata = this.repository.attachCredentialMetadata({
        providerId,
        authMethodId,
        secretName,
        referenceId: storeResult.id,
        status: "ACTIVE",
        now: new Date().toISOString(),
      });
      return {
        providerId: metadata.providerId,
        authMethodId: metadata.authMethodId,
        secretName: metadata.secretName,
        referenceId: metadata.referenceId,
        status: metadata.status,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      };
    } catch (error) {
      // Компенсация: отзываем запись keyring, чтобы БД и keyring остались
      // согласованными (метаданные не пишутся без секрета).
      try {
        await this.secretStore.revoke(PROVIDER_CREDENTIAL_SERVICE, secretName);
      } catch {
        // Не заменяет исходную ошибку и не раскрывает значение секрета.
      }
      throw error;
    }
  }

  /**
   * Разрешает секретные байты credentials для Run.
   * Возвращает байты только для точной ревизии снимка конфигурации и очищает
   * собственный временный буфер; владение возвращённым буфером — у вызывающего.
   */
  async resolveCredentialForRun(
    providerId: string,
    authMethodId: string,
    configRevision: number,
  ): Promise<Uint8Array> {
    const configuration = this.repository.getProviderConfiguration(providerId);
    if (!configuration) throw new ProviderConfigurationMissingError(providerId);
    if (!configuration.enabled) {
      throw new ProviderCredentialMissingError(`Provider '${providerId}' is disabled`);
    }

    const snapshot = this.repository.getConfigSnapshot(providerId, configRevision);
    if (!snapshot) throw new ProviderConfigSnapshotUnknownError(providerId, configRevision);
    if (snapshot.selectedAuthMethod !== authMethodId) {
      throw new ProviderCredentialMissingError(
        `Auth method '${authMethodId}' does not match snapshot revision ${configRevision}`,
      );
    }

    const metadata = this.repository.getCredentialMetadata(providerId, authMethodId);
    if (!metadata) {
      throw new ProviderCredentialMissingError(`Credential for '${providerId}/${authMethodId}' is not configured`);
    }
    if (metadata.status !== "ACTIVE") {
      throw new ProviderCredentialMissingError(`Credential for '${providerId}/${authMethodId}' is not active`);
    }

    let value: string | undefined;
    try {
      value = await this.secretStore.resolveForService(PROVIDER_CREDENTIAL_SERVICE, metadata.secretName);
    } catch (error) {
      if (isSecretStoreUnavailableError(error)) {
        throw new ProviderCredentialStoreUnavailableError();
      }
      throw error;
    }
    if (value === undefined) {
      throw new ProviderCredentialMissingError(`Credential value for '${providerId}/${authMethodId}' is missing`);
    }

    const internal = Buffer.from(value, "utf8");
    try {
      const result = Uint8Array.from(internal);
      return result;
    } finally {
      internal.fill(0);
    }
  }

  /** Удаляет локальный credential провайдера: keyring + метаданные (транзакционно по метаданным). */
  async deleteLocalCredential(providerId: string, authMethodId: string): Promise<boolean> {
    const metadata = this.repository.getCredentialMetadata(providerId, authMethodId);
    if (!metadata) return false;
    try {
      await this.secretStore.revoke(PROVIDER_CREDENTIAL_SERVICE, metadata.secretName);
    } catch (error) {
      if (isSecretStoreUnavailableError(error)) {
        throw new ProviderCredentialStoreUnavailableError();
      }
      throw error;
    }
    this.repository.removeCredentialMetadata(providerId, authMethodId);
    return true;
  }

  /** Возвращает метаданные credentials (без значений) для статусных проекций. */
  getCredentialMetadata(providerId: string, authMethodId: string): ProviderCredentialMetadataRecord | undefined {
    return this.repository.getCredentialMetadata(providerId, authMethodId);
  }
}

/** Создаёт credential-хранилище провайдеров поверх переданного SecretStore. */
export function createProviderCredentialStore(
  secretStore: SecretStore,
  repository: ProviderSettingsRepository,
): ProviderCredentialStore {
  return new ProviderCredentialStore(secretStore, repository);
}
