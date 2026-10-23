import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG_SOURCE_PIN,
  MODEL_CATALOG_VERSION,
  getModel,
  getModelsForProvider,
  hasModel,
  listAllModelIdentities,
  listModelEntries,
} from '../../../../src/modules/runtime/providers/provider-model-catalog.js';
import { listProviders } from '../../../../src/modules/runtime/providers/provider-catalog.js';
import type { ProviderCapability } from '../../../../src/modules/runtime/providers/provider-types.js';

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

const MODEL_TYPES = ['chat', 'image', 'video', 'embedding'] as const;

describe('provider-model-catalog', () => {
  it('версия каталога и source pin зафиксированы', () => {
    expect(MODEL_CATALOG_VERSION).toBeGreaterThanOrEqual(1);
    expect(MODEL_CATALOG_SOURCE_PIN).toBe('d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1');
  });

  it('каждая модель привязана к провайдеру из каталога', () => {
    const providerIds = new Set(listProviders().map((def) => def.id));
    for (const entry of listModelEntries()) {
      expect(providerIds.has(entry.providerId), `неизвестный провайдер ${entry.providerId}`).toBe(true);
    }
  });

  it('идентичность модели всегда пара (providerId, modelId), дубликатов нет', () => {
    const pairs = listAllModelIdentities();
    expect(pairs.length).toBe(listModelEntries().length);
    for (const pair of pairs) {
      expect(pair.providerId.length).toBeGreaterThan(0);
      expect(pair.modelId.length).toBeGreaterThan(0);
    }
    const seen = new Set(pairs.map((pair) => `${pair.providerId}::${pair.modelId}`));
    expect(seen.size).toBe(pairs.length);
  });

  it('количество статичных моделей совпадает с заявленным в каталоге провайдеров', () => {
    for (const def of listProviders()) {
      const entries = getModelsForProvider(def.id);
      if (def.modelSource.kind === 'remote') {
        expect(entries.length, `remote провайдер ${def.id}`).toBe(0);
      } else {
        expect(entries.length, `modelCount провайдера ${def.id}`).toBe(def.modelSource.modelCount);
      }
    }
  });

  it('у провайдеров с API-каталогом флаг providerCatalog установлен', () => {
    for (const def of listProviders()) {
      if (def.modelSource.kind === 'remote' || def.modelSource.kind === 'builtin-and-remote') {
        expect(def.modelSource.providerCatalog, `providerCatalog провайдера ${def.id}`).toBe(true);
      }
    }
  });

  it('каждая запись: displayName непустой, тип допустим, capabilities валидны и связаны с типом', () => {
    for (const entry of listModelEntries()) {
      expect(entry.displayName.length, `displayName ${entry.providerId}/${entry.modelId}`).toBeGreaterThan(0);
      expect(MODEL_TYPES, `тип ${entry.providerId}/${entry.modelId}`).toContain(entry.type);
      expect(entry.capabilities.length, `capabilities ${entry.providerId}/${entry.modelId}`).toBeGreaterThan(0);
      for (const capability of entry.capabilities) {
        expect(CAPABILITIES, `capability ${entry.providerId}/${entry.modelId}`).toContain(capability);
      }
      if (entry.type === 'chat') {
        expect(entry.capabilities, `chat ${entry.providerId}/${entry.modelId}`).toContain('chat');
      }
      if (entry.type === 'image') {
        expect(entry.capabilities, `image ${entry.providerId}/${entry.modelId}`).toContain('imageGeneration');
      }
      if (entry.type === 'video') {
        expect(entry.capabilities, `video ${entry.providerId}/${entry.modelId}`).toContain('videoGeneration');
      }
      if (entry.type === 'embedding') {
        expect(entry.capabilities, `embedding ${entry.providerId}/${entry.modelId}`).toContain('embeddings');
      }
    }
  });

  it('модельные записи содержат только разрешённые поля', () => {
    const allowedKeys = new Set([
      'providerId', 'modelId', 'displayName', 'type', 'capabilities', 'contextWindowTokens', 'maxOutput',
    ]);
    for (const entry of listModelEntries()) {
      const keys = Object.keys(entry);
      for (const key of keys) {
        expect(allowedKeys.has(key), `неожиданное поле ${key} у ${entry.providerId}/${entry.modelId}`).toBe(true);
      }
      expect(keys, `нет providerId у ${entry.providerId}/${entry.modelId}`).toContain('providerId');
      expect(keys, `нет modelId у ${entry.providerId}/${entry.modelId}`).toContain('modelId');
      expect(keys, `нет displayName у ${entry.providerId}/${entry.modelId}`).toContain('displayName');
      expect(keys, `нет type у ${entry.providerId}/${entry.modelId}`).toContain('type');
      expect(keys, `нет capabilities у ${entry.providerId}/${entry.modelId}`).toContain('capabilities');
    }
  });

  it('неизвестная модель и провайдер завершаются fail-closed', () => {
    expect(getModel('openai', 'nonexistent-model')).toBeUndefined();
    expect(getModel('nonexistent-provider', 'gpt-x')).toBeUndefined();
    expect(hasModel('openai', 'nonexistent-model')).toBe(false);
    expect(hasModel('nonexistent-provider', 'gpt-x')).toBe(false);
  });

  it('известные пары резолвятся (спот-чек по источнику)', () => {
    expect(hasModel('openai', 'gpt-5.5')).toBe(true);
    expect(hasModel('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(getModel('openai', 'gpt-5.5')?.displayName.length).toBeGreaterThan(0);
  });

  it('совокупный модельный каталог непуст и содержит все провайдеры', () => {
    const entries = listModelEntries();
    expect(entries.length).toBeGreaterThan(500);
    const withModels = new Set(entries.map((entry) => entry.providerId));
    const providers = listProviders();
    const staticProviders = providers.filter((def) => def.modelSource.kind !== 'remote');
    for (const def of staticProviders) {
      expect(withModels.has(def.id), `нет моделей у ${def.id}`).toBe(true);
    }
  });
});
