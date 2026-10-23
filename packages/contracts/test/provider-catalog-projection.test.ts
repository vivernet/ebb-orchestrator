import { expect, expectTypeOf, test } from 'vitest';
import {
  PROVIDER_CATALOG_PROJECTION,
  PROVIDER_CATALOG_PROJECTION_VERSION,
  type ProviderAuthMethod,
  type ProviderCatalogEntryProjection,
} from '../src/api.js';

function looksLikeSecret(text: string): boolean {
  return [
    /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"',}]+/iu,
  ].some((pattern) => pattern.test(text));
}

test('проекция каталога провайдеров содержит ровно 86 уникальных ID', () => {
  expect(PROVIDER_CATALOG_PROJECTION.length).toBe(86);
  const ids = PROVIDER_CATALOG_PROJECTION.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(86);
  for (const id of ids) {
    expect(id).toMatch(/^[a-z0-9_-]+$/);
  }
});

test('каждая запись проекции — безопасная display-метаданные', () => {
  for (const entry of PROVIDER_CATALOG_PROJECTION) {
    expect(entry.displayName.length).toBeGreaterThan(0);
    expect(entry.category).toMatch(/^[a-z]+$/);
    expect(entry.authMethods.length).toBeGreaterThan(0);
    expect(entry.capabilities.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entry);
    expect(looksLikeSecret(serialized)).toBe(false);
    expect(serialized).not.toMatch(/https?:\/\//);
  }
});

test('версия проекции зафиксирована и тип совместим', () => {
  expect(PROVIDER_CATALOG_PROJECTION_VERSION).toBe(1);
  const entry: ProviderCatalogEntryProjection = PROVIDER_CATALOG_PROJECTION[0];
  expectTypeOf(entry.authMethods[0]).toEqualTypeOf<ProviderAuthMethod>();
});
