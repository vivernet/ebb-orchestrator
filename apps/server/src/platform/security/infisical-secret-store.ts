import { InfisicalSDK } from "@infisical/sdk";
import type { Database } from "../database/database.js";
import { SecretStoreUnavailableError, type SecretMetadata, type SecretStore, type StoreResult } from "./secret-store.js";

export interface InfisicalSecretStoreOptions {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath?: string;
  siteUrl?: string;
}

export interface SecretBackendEnvironment {
  EBB_SECRET_BACKEND?: string;
  INFISICAL_CLIENT_ID?: string;
  INFISICAL_CLIENT_SECRET?: string;
  INFISICAL_PROJECT_ID?: string;
  INFISICAL_ENVIRONMENT?: string;
  INFISICAL_SECRET_PATH?: string;
  INFISICAL_SITE_URL?: string;
}

/** Возвращает Infisical options только для явно выбранного remote backend. */
export function resolveInfisicalSecretStoreOptions(env: SecretBackendEnvironment): InfisicalSecretStoreOptions | undefined {
  if (env.EBB_SECRET_BACKEND !== "infisical") return undefined;
  const { INFISICAL_CLIENT_ID: clientId, INFISICAL_CLIENT_SECRET: clientSecret, INFISICAL_PROJECT_ID: projectId, INFISICAL_ENVIRONMENT: environment } = env;
  if (!clientId || !clientSecret || !projectId || !environment) {
    throw new Error("Infisical secret storage is misconfigured");
  }
  return {
    clientId,
    clientSecret,
    projectId,
    environment,
    ...(env.INFISICAL_SECRET_PATH ? { secretPath: env.INFISICAL_SECRET_PATH } : {}),
    ...(env.INFISICAL_SITE_URL ? { siteUrl: env.INFISICAL_SITE_URL } : {}),
  };
}

/** Узкий SDK port позволяет тестировать SecretStore без сетевых вызовов. */
export interface InfisicalClient {
  auth(): { universalAuth: { login(options: { clientId: string; clientSecret: string }): Promise<unknown> } };
  secrets(): {
    getSecret(options: { secretName: string; projectId: string; environment: string; secretPath?: string }): Promise<{ secretValue: string }>;
    createSecret(secretName: string, options: { projectId: string; environment: string; secretValue: string; secretPath?: string }): Promise<unknown>;
    updateSecret(secretName: string, options: { projectId: string; environment: string; secretValue: string; secretPath?: string }): Promise<unknown>;
    deleteSecret(secretName: string, options: { projectId: string; environment: string; secretPath?: string }): Promise<unknown>;
  };
}

/**
 * Хранит plaintext только в Infisical; SQLite получает исключительно metadata.
 * Аутентификация Machine Identity выполняется лениво при первой операции.
 */
export class InfisicalSecretStore implements SecretStore {
  private authenticated = false;

  constructor(
    private readonly db: Database,
    private readonly client: InfisicalClient,
    private readonly options: InfisicalSecretStoreOptions,
  ) {}

  async store(service: string, name: string, value: string): Promise<StoreResult> {
    await this.authenticate();
    const secretName = this.remoteName(service, name);
    const previous = await this.findExisting(secretName);
    try {
      if (previous === undefined) await this.client.secrets().createSecret(secretName, this.writeOptions(value));
      else await this.client.secrets().updateSecret(secretName, this.writeOptions(value));
    } catch {
      throw new SecretStoreUnavailableError();
    }

    const id = `infisical_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      this.db.run(
        `INSERT OR REPLACE INTO secrets (reference_id, service, name, created_at, updated_at)
         VALUES ($id, $service, $name, $created_at, $updated_at)`,
        { $id: id, $service: service, $name: name, $created_at: now, $updated_at: now },
      );
    } catch (error) {
      try {
        if (previous === undefined) await this.client.secrets().deleteSecret(secretName, this.baseOptions());
        else await this.client.secrets().updateSecret(secretName, this.writeOptions(previous));
      } catch {
        // Исходная database ошибка важнее; secret value не попадает в diagnostics.
      }
      throw error;
    }
    return { id, service, name };
  }

  async resolveForService(service: string, name: string): Promise<string | undefined> {
    await this.authenticate();
    const value = await this.findExisting(this.remoteName(service, name));
    return value;
  }

  async revoke(service: string, name: string): Promise<void> {
    await this.authenticate();
    try {
      await this.client.secrets().deleteSecret(this.remoteName(service, name), this.baseOptions());
    } catch {
      throw new SecretStoreUnavailableError();
    }
    this.db.run("DELETE FROM secrets WHERE service = $service AND name = $name", { $service: service, $name: name });
  }

  async listMetadata(service: string): Promise<SecretMetadata[]> {
    return this.db.all<{ reference_id: string; service: string; name: string; created_at: number; updated_at: number }>(
      "SELECT reference_id, service, name, created_at, updated_at FROM secrets WHERE service = $service",
      { service },
    ).map((row) => ({ referenceId: row.reference_id, service: row.service, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private async authenticate(): Promise<void> {
    if (this.authenticated) return;
    try {
      await this.client.auth().universalAuth.login({ clientId: this.options.clientId, clientSecret: this.options.clientSecret });
      this.authenticated = true;
    } catch {
      throw new SecretStoreUnavailableError();
    }
  }

  private async findExisting(secretName: string): Promise<string | undefined> {
    try {
      return (await this.client.secrets().getSecret({ secretName, ...this.baseOptions() })).secretValue;
    } catch (error) {
      if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 404) return undefined;
      throw new SecretStoreUnavailableError();
    }
  }

  private baseOptions(): { projectId: string; environment: string; secretPath?: string } {
    return { projectId: this.options.projectId, environment: this.options.environment, ...(this.options.secretPath ? { secretPath: this.options.secretPath } : {}) };
  }

  private writeOptions(secretValue: string): { projectId: string; environment: string; secretPath?: string; secretValue: string } {
    return { ...this.baseOptions(), secretValue };
  }

  private remoteName(service: string, name: string): string {
    return `EBB_${Buffer.from(`${service}\u0000${name}`, "utf8").toString("base64url")}`;
  }
}

/** Создаёт production adapter только при явной Infisical configuration. */
export function createInfisicalSecretStore(db: Database, options: InfisicalSecretStoreOptions): InfisicalSecretStore {
  return new InfisicalSecretStore(db, new InfisicalSDK(options.siteUrl ? { siteUrl: options.siteUrl } : {}) as unknown as InfisicalClient, options);
}
