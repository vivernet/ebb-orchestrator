import { describe, expect, it } from "vitest";
import {
  PROVIDER_REGISTRY_VERSION,
  assertSupportedModel,
  listSupportedModels,
  resolveProviderForModel,
  type ProviderRegistryEntry,
} from "../../../src/modules/runtime/hermes/hermes-provider-registry.js";

/** Документированные стандартные env-имена built-in провайдеров (контракт Task 1). */
const DOCUMENTED_STANDARD_KEYS = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);

/** Паттерны секретов (из спайк-контракта Task 1) для проверки отсутствия утечки. */
function looksLikeSecret(text: string): boolean {
  return [
    /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"',}]+/iu,
  ].some((pattern) => pattern.test(text));
}

describe("hermes-provider-registry", () => {
  it("assertSupportedModel бросает RUN_REQUEST_MODEL_UNSUPPORTED для неизвестной модели", () => {
    expect(() => assertSupportedModel("nonexistent-model"))
      .toThrow("RUN_REQUEST_MODEL_UNSUPPORTED");
  });

  it("resolveProviderForModel('default') возвращает undefined (legacy-путь)", () => {
    expect(resolveProviderForModel("default")).toBeUndefined();
  });

  it("assertSupportedModel('default') не бросает", () => {
    expect(() => assertSupportedModel("default")).not.toThrow();
  });

  it("resolveProviderForModel возвращает корректную запись для built-in моделей", () => {
    expect(resolveProviderForModel("gpt-4o")).toEqual({
      model: "gpt-4o", provider: "openai-api", envKey: "OPENAI_API_KEY",
    });
    expect(resolveProviderForModel("claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6", provider: "anthropic", envKey: "ANTHROPIC_API_KEY",
    });
  });

  it("для каждой записи listSupportedModels() resolveProviderForModel возвращает ту же запись", () => {
    for (const entry of listSupportedModels()) {
      expect(resolveProviderForModel(entry.model)).toEqual(entry);
    }
  });

  it("все записи: provider/envKey непустые, envKey без TOKEN/SECRET-суффиксов", () => {
    for (const entry of listSupportedModels()) {
      expect(entry.provider.length, `provider записи ${entry.model}`).toBeGreaterThan(0);
      expect(entry.envKey.length, `envKey записи ${entry.model}`).toBeGreaterThan(0);
      expect(entry.envKey.toUpperCase(), `envKey записи ${entry.model}`)
        .not.toMatch(/(TOKEN|SECRET)$/);
    }
  });

  it("имена моделей уникальны", () => {
    const models = listSupportedModels().map((entry) => entry.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("реестр не содержит секретных значений — только документированные имена переменных", () => {
    const entries = listSupportedModels();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(DOCUMENTED_STANDARD_KEYS.has(entry.envKey), `envKey записи ${entry.model}`).toBe(true);
      expect(looksLikeSecret(entry.envKey)).toBe(false);
      expect(looksLikeSecret(entry.provider)).toBe(false);
      expect(looksLikeSecret(entry.model)).toBe(false);
    }
  });

  it("реестр — статический built-in набор (только openai-api/anthropic, без кастомных)", () => {
    const providers = new Set(listSupportedModels().map((entry) => entry.provider));
    expect(providers).toEqual(new Set(["openai-api", "anthropic"]));
  });

  it("версия реестра зафиксирована (PASS: константа существует и читается)", () => {
    expect(PROVIDER_REGISTRY_VERSION).toBe(1);
  });
});
