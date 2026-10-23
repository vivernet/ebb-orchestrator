/**
 * Модельный каталог Ebb (plan-24, Task 1).
 *
 * Предоставляет доступ к статичным спискам моделей (источник — закреплённый
 * LobeHub `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`) и идентичность модели
 * всегда в виде пары `(providerId, modelId)`. Для провайдеров с API-каталогом
 * (`modelSource.providerCatalog`) статичный список может отсутствовать — модели
 * загружаются из API провайдера на этапе Task 3/6.
 *
 * Контракты:
 *  - `listModelEntries()` — все записи; `getModelsForProvider(providerId)` —
 *    записи конкретного провайдера; `getModel(providerId, modelId)` — одна
 *    запись по паре; `hasModel` — проверка существования;
 *  - неизвестные провайдер/модель завершаются fail-closed (undefined/false);
 *  - голый `modelId` нигде не используется как идентичность.
 */

import { assertProviderKnown } from './provider-catalog.js';
import { GENERATED_MODEL_ENTRIES } from './provider-model-data.js';
import type { ModelIdentity, ProviderModelEntry } from './provider-types.js';

/** Версия модельного каталога — инкрементируется при изменении записей. */
export const MODEL_CATALOG_VERSION = 1 as const;

/** Закреплённый источник LobeHub (plan-24, Authority). */
export const MODEL_CATALOG_SOURCE_PIN = 'd1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1' as const;

/** Замороженные записи модельного каталога. */
export const MODEL_ENTRIES: readonly ProviderModelEntry[] = GENERATED_MODEL_ENTRIES;

/** Возвращает копию всех записей модельного каталога (только присутствующие поля). */
export function listModelEntries(): readonly ProviderModelEntry[] {
  return MODEL_ENTRIES.map((entry) => ({
    providerId: entry.providerId,
    modelId: entry.modelId,
    displayName: entry.displayName,
    type: entry.type,
    capabilities: [...entry.capabilities],
    ...(entry.contextWindowTokens !== undefined ? { contextWindowTokens: entry.contextWindowTokens } : {}),
    ...(entry.maxOutput !== undefined ? { maxOutput: entry.maxOutput } : {}),
  }));
}

/** Возвращает все записи моделей указанного провайдера (пустой список для неизвестного id). */
export function getModelsForProvider(providerId: string): readonly ProviderModelEntry[] {
  assertProviderKnown(providerId);
  return MODEL_ENTRIES.filter((entry) => entry.providerId === providerId);
}

/**
 * Находит запись модели по паре `(providerId, modelId)`.
 * Для неизвестного провайдера или модели возвращает undefined (fail-closed).
 */
export function getModel(providerId: string, modelId: string): ProviderModelEntry | undefined {
  if (!getProviderSafe(providerId)) return undefined;
  return MODEL_ENTRIES.find((entry) => entry.providerId === providerId && entry.modelId === modelId);
}

/** Проверяет существование модели по паре `(providerId, modelId)`. */
export function hasModel(providerId: string, modelId: string): boolean {
  return getModel(providerId, modelId) !== undefined;
}

/** Возвращает список всех идентичностей моделей как пар `(providerId, modelId)`. */
export function listAllModelIdentities(): readonly ModelIdentity[] {
  return MODEL_ENTRIES.map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId }));
}

/** Внутренний небросающий доступ к провайдеру для fail-closed проверок. */
function getProviderSafe(providerId: string): boolean {
  try {
    assertProviderKnown(providerId);
    return true;
  } catch {
    return false;
  }
}
