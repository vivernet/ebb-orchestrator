/**
 * Общие фикстуры тестов auth-потоков провайдеров (plan-24, Task 4).
 * Все сетевые вызовы — мок шлюза без реальной сети.
 */

import { ProviderNetworkGateway, type GatewayConnectFn, type GatewayConnectParams } from "../../../../../src/modules/runtime/providers/provider-network-gateway.js";
import { createSqliteDatabase } from "../../../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../../../helpers/migrations.js";
import { InMemorySecretStore } from "../../../../../src/platform/security/secret-store.js";
import { createProviderSettingsRepository, type ProviderSettingsRepository } from "../../../../../src/modules/runtime/providers/provider-settings-repository.js";
import { createProviderCredentialStore, type ProviderCredentialStore } from "../../../../../src/modules/runtime/providers/provider-credential-store.js";

export const PUBLIC_IP = "93.184.216.34";

/** Ответ мок-шлюза. */
export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface MockGateway {
  gateway: ProviderNetworkGateway;
  calls: GatewayConnectParams[];
  respond(handler: (params: GatewayConnectParams, index: number) => MockResponse | Promise<MockResponse>): void;
}

/** Создаёт мок-шлюз с записью всех вызовов и сменяемым обработчиком. */
export function createMockGateway(): MockGateway {
  const calls: GatewayConnectParams[] = [];
  let handler: (params: GatewayConnectParams, index: number) => MockResponse | Promise<MockResponse> = () => ({ status: 200, body: "{}" });
  const connect: GatewayConnectFn = async (params) => {
    calls.push(params);
    const result = await handler(params, calls.length - 1);
    return { status: result.status, headers: result.headers ?? {}, body: result.body ?? "" };
  };
  const gateway = new ProviderNetworkGateway({}, {
    lookup: async () => [PUBLIC_IP],
    connect,
  });
  return {
    gateway,
    calls,
    respond(next) {
      handler = next;
    },
  };
}

export interface AuthTestEnv {
  repository: ProviderSettingsRepository;
  credentialStore: ProviderCredentialStore;
  secretStore: InMemorySecretStore;
  close(): void;
}

/** Создаёт SQLite + репозиторий + InMemory SecretStore + credential store. */
export function createAuthTestEnv(): AuthTestEnv {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const repository = createProviderSettingsRepository(db);
  const secretStore = new InMemorySecretStore(db);
  const credentialStore = createProviderCredentialStore(secretStore, repository);
  return {
    repository,
    credentialStore,
    secretStore,
    close: () => db.close(),
  };
}

/** Устанавливает конфигурацию провайдера (несекретные настройки + метод). */
export function installProviderConfig(
  repository: ProviderSettingsRepository,
  providerId: string,
  methodId: string,
  config: Readonly<Record<string, unknown>> = {},
): void {
  repository.saveProviderConfiguration({
    providerId,
    enabled: true,
    selectedAuthMethod: methodId,
    config: { endpoint: "https://api.example.com/v1", ...config },
    modelSelection: { defaultModelId: null, roleDefaults: {} },
  });
}

/** Собирает форму urlencoded из параметров. */
export function parseForm(body: string | null): Record<string, string> {
  if (!body) return {};
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [key, value] = pair.split("=");
    if (key) out[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
  }
  return out;
}
