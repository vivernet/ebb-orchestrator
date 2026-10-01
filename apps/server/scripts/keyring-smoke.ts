import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecretStore } from '../src/platform/security/secret-store.js';
import { KeyringSecretStore } from '../src/platform/security/keyring-secret-store.js';

const SERVICE = 'ebb-orchestrator-ci-smoke';

type SmokeStage = 'store' | 'retrieve' | 'revoke' | 'verify-revoke' | 'cleanup';

/**
 * Выполняет безопасную проверку записи и удаления случайного тестового значения через production SecretStore.
 * Cleanup запускается и после частичного сбоя; текст ошибок содержит только этап и подтверждение удаления.
 * @param store Реальный production SecretStore в CI или изолированная подмена в unit-тесте.
 * @returns Promise завершается только после подтверждённого удаления записи из keyring.
 * @throws Error если native backend недоступен, чтение не совпало или cleanup нельзя подтвердить.
 */
export async function runKeyringSmoke(store: SecretStore = new KeyringSecretStore()): Promise<void> {
  const name = `workflow-${randomUUID()}`;
  const value = `ebb-orchestrator-non-production-${randomBytes(32).toString('hex')}`;
  let stage: SmokeStage = 'store';
  let failedStage: SmokeStage | undefined;
  let cleanupVerified = false;

  try {
    await store.store(SERVICE, name, value);
    stage = 'retrieve';
    if (await store.resolveForService(SERVICE, name) !== value) {
      throw new Error('The stored value could not be verified.');
    }

    stage = 'revoke';
    await store.revoke(SERVICE, name);
    stage = 'verify-revoke';
    cleanupVerified = await store.resolveForService(SERVICE, name) === undefined;
    if (!cleanupVerified) throw new Error('The revoked entry is still present.');
  } catch {
    failedStage = stage;
  } finally {
    if (!cleanupVerified) {
      try {
        stage = 'cleanup';
        await store.revoke(SERVICE, name);
        cleanupVerified = await store.resolveForService(SERVICE, name) === undefined;
      } catch {
        cleanupVerified = false;
      }
    }
  }

  if (failedStage !== undefined) {
    throw new Error(`KEYRING_SMOKE_FAILED stage=${failedStage} cleanup=${cleanupVerified ? 'verified' : 'unverified'}`);
  }
  if (!cleanupVerified) throw new Error(`KEYRING_SMOKE_FAILED stage=${stage} cleanup=unverified`);
}

async function main(): Promise<void> {
  try {
    await runKeyringSmoke();
    process.stdout.write('KEYRING_SMOKE_PASS cleanup=verified\n');
  } catch (error) {
    const message = error instanceof Error && /^KEYRING_SMOKE_FAILED stage=(store|retrieve|revoke|verify-revoke|cleanup) cleanup=(verified|unverified)$/.test(error.message)
      ? error.message
      : 'KEYRING_SMOKE_FAILED stage=bootstrap cleanup=unverified';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void main();
}
