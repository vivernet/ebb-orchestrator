import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CATALOG_SOURCE_PIN,
  PROVIDER_CATALOG_VERSION,
  PROVIDER_DEFINITIONS,
  assertProviderKnown,
  getProvider,
  listProviders,
  toSafeProviderProjection,
} from '../../../../src/modules/runtime/providers/provider-catalog.js';
import type {
  ProviderAuthMethod,
  ProviderCapability,
  ProviderCategory,
} from '../../../../src/modules/runtime/providers/provider-types.js';
import { EXPECTED_PROVIDER_IDS } from './provider-ids.fixture.js';

/** Паттерны секретов — из спайк-контракта Task 1 (только запрещённые значения). */
function looksLikeSecret(text: string): boolean {
  return [
    /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"',}]+/iu,
  ].some((pattern) => pattern.test(text));
}

const AUTH_METHODS: readonly ProviderAuthMethod[] = [
  'api-key',
  'credential-fields',
  'subscription-token',
  'oauth-device-code',
  'oauth-pkce',
  'cloud-identity',
  'local-endpoint',
];

const CATEGORIES: readonly ProviderCategory[] = [
  'chat',
  'image',
  'video',
  'embedding',
  'platform',
  'gateway',
  'local',
];

const CAPABILITIES: readonly ProviderCapability[] = [
  'chat',
  'streaming',
  'toolCalling',
  'structuredOutput',
  'vision',
  'audio',
  'imageGeneration',
  'videoGeneration',
  'embeddings',
  'reranking',
];

const CREDENTIAL_KINDS = new Set([
  'api-key',
  'access-key-id',
  'secret-access-key',
  'session-token',
  'oauth-access-token',
  'oauth-refresh-token',
  'bearer-token',
]);

const CONFIG_KINDS = new Set([
  'endpoint',
  'string',
  'account-id',
  'deployment-name',
  'resource-name',
  'region',
  'project-id',
  'api-version',
  'fetcher-url',
  'deploy-name',
  'boolean',
]);

describe('provider-catalog', () => {
  it('версия каталога и source pin зафиксированы', () => {
    expect(PROVIDER_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(PROVIDER_CATALOG_SOURCE_PIN).toBe('d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1');
  });

  it('каталог содержит ровно 86 уникальных provider ID без лишних', () => {
    const ids = listProviders().map((def) => def.id);
    expect(ids.length).toBe(86);
    expect(new Set(ids).size).toBe(86);
    expect(new Set(ids)).toEqual(new Set(EXPECTED_PROVIDER_IDS));
  });

  it('каждый ожидаемый ID присутствует в определениях', () => {
    const ids = new Set(listProviders().map((def) => def.id));
    for (const id of EXPECTED_PROVIDER_IDS) {
      expect(ids.has(id), `отсутствует провайдер ${id}`).toBe(true);
    }
  });

  it('каждая запись имеет корректный id и непустой displayName', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.id, `id записи`).toMatch(/^[a-z0-9_-]+$/);
      expect(def.displayName.length, `displayName провайдера ${def.id}`).toBeGreaterThan(0);
      expect(looksLikeSecret(def.displayName), `displayName провайдера ${def.id}`).toBe(false);
    }
  });

  it('категория каждой записи допустима', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(CATEGORIES, `категория провайдера ${def.id}`).toContain(def.category);
    }
  });

  it('authMethods непустые и допустимы', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.authMethods.length, `authMethods провайдера ${def.id}`).toBeGreaterThan(0);
      for (const method of def.authMethods) {
        expect(AUTH_METHODS, `authMethod провайдера ${def.id}`).toContain(method);
      }
      expect(new Set(def.authMethods).size, `повтор authMethods провайдера ${def.id}`).toBe(def.authMethods.length);
    }
  });

  it('credentialSchema валидна и не содержит секретных значений', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.credentialSchema.version, `version провайдера ${def.id}`).toBeGreaterThanOrEqual(1);
      for (const field of def.credentialSchema.fields) {
        expect(field.name, `имя поля ${def.id}`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(field.label.length, `label ${def.id}.${field.name}`).toBeGreaterThan(0);
        expect(CREDENTIAL_KINDS, `kind ${def.id}.${field.name}`).toContain(field.kind);
        expect(looksLikeSecret(field.label), `label ${def.id}.${field.name}`).toBe(false);
      }
      const names = def.credentialSchema.fields.map((field) => field.name);
      expect(new Set(names).size, `дубликат полей ${def.id}`).toBe(names.length);
    }
  });

  it('configSchema валидна, значения не содержат URL/endpoint значений', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.configSchema.version, `version провайдера ${def.id}`).toBeGreaterThanOrEqual(1);
      for (const field of def.configSchema.fields) {
        expect(field.name, `имя поля ${def.id}`).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(field.label.length, `label ${def.id}.${field.name}`).toBeGreaterThan(0);
        expect(CONFIG_KINDS, `kind ${def.id}.${field.name}`).toContain(field.kind);
        expect(field.label, `label ${def.id}.${field.name}`).not.toMatch(/https?:\/\//);
        expect(field.placeholder ?? '', `placeholder ${def.id}.${field.name}`).not.toMatch(/https?:\/\//);
      }
      const names = def.configSchema.fields.map((field) => field.name);
      expect(new Set(names).size, `дубликат полей ${def.id}`).toBe(names.length);
    }
  });

  it('modelSource структурирован и согласован', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      const source = def.modelSource;
      expect(['builtin', 'remote', 'builtin-and-remote', 'static-platform', 'derived'], `kind провайдера ${def.id}`)
        .toContain(source.kind);
      expect(source.modelCount, `modelCount провайдера ${def.id}`).toBeGreaterThanOrEqual(0);
      if (source.kind === 'derived') {
        expect(source.derivedFrom, `derivedFrom провайдера ${def.id}`).toBeTruthy();
      }
      if (source.kind === 'remote') {
        expect(source.providerCatalog, `providerCatalog провайдера ${def.id}`).toBe(true);
        expect(source.modelCount).toBe(0);
      }
      if (source.kind === 'static-platform') {
        expect(source.providerCatalog).toBe(false);
      }
    }
  });

  it('capabilities непустые и допустимы', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.capabilities.length, `capabilities провайдера ${def.id}`).toBeGreaterThan(0);
      for (const capability of def.capabilities) {
        expect(CAPABILITIES, `capability провайдера ${def.id}`).toContain(capability);
      }
    }
  });

  it('runtimeAdapterId непустой для каждой записи', () => {
    for (const def of PROVIDER_DEFINITIONS) {
      expect(def.runtimeAdapterId, `runtimeAdapterId провайдера ${def.id}`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('безопасная проекция не содержит секретов и opaque-ссылок', () => {
    const projection = listProviders().map((def) => toSafeProviderProjection(def));
    expect(projection.length).toBe(86);
    const serialized = JSON.stringify(projection);
    expect(looksLikeSecret(serialized)).toBe(false);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]+/);
  });

  it('неизвестный провайдер завершается fail-closed', () => {
    expect(getProvider('nonexistent-provider')).toBeUndefined();
    expect(getProvider('openai')?.displayName).toBe('OpenAI');
    expect(() => assertProviderKnown('nonexistent-provider')).toThrow('PROVIDER_UNKNOWN');
  });
});
