/**
 * Статический реестр built-in провайдеров/моделей Hermes (Task 2 плана 23, IN-005).
 *
 * Реестр хранит ТОЛЬКО имена: модель, провайдер и стандартную env-переменную.
 * Никаких значений ключей и чтения секретов пользователя
 * (`~/.hermes/.env`, `auth.json`, `config.yaml`) здесь нет и быть не может.
 *
 * ИСТОЧНИК (исходники установленного Hermes, без чтения секретов):
 *  - провайдеры и их стандартные env-переменные: `hermes_cli/auth.py`,
 *    `_REGISTRY_ROWS` / `PROVIDER_REGISTRY` (строки 175–254): для openai-api
 *    первая (стандартная) env-переменная — `OPENAI_API_KEY`; для anthropic —
 *    `ANTHROPIC_API_KEY` (строки 217–218);
 *  - модели per-provider: `hermes_cli/models_catalog_static.py`,
 *    `_PROVIDER_MODELS` (строки 171–310): `openai-api` — строки 176–181,
 *    `anthropic` — строки 219–224.
 *
 * Ограничение v1: каталог ограничен стабильным набором built-in API-key
 * провайдеров (openai-api, anthropic); кастомные/пользовательские провайдеры
 * не добавляются.
 */

/** Версия реестра — инкрементируется при изменении состава записей. */
export const PROVIDER_REGISTRY_VERSION = 1 as const;

/** Запись реестра: built-in модель Hermes и её провайдер/env-переменная. */
export interface ProviderRegistryEntry {
  readonly model: string;
  readonly provider: string;
  readonly envKey: string;
}

/**
 * Модели провайдера `openai-api` (OpenAI API, api.openai.com).
 * Источник: `hermes_cli/models_catalog_static.py`, `_PROVIDER_MODELS["openai-api"]`.
 */
const OPENAI_API_MODELS: readonly string[] = Object.freeze([
  "gpt-6.1-sol", "gpt-6.1-sol-pro", "gpt-6-sol", "gpt-6-sol-pro", "gpt-6-luna", "gpt-6-luna-pro",
  "gpt-5.6-sol", "gpt-5.6-sol-pro", "gpt-5.6-terra", "gpt-5.6-terra-pro", "gpt-5.6-luna",
  "gpt-5.6-luna-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5-mini", "gpt-5.3-codex", "gpt-4.1", "gpt-4o", "gpt-4o-mini",
]);

/**
 * Модели провайдера `anthropic` (Anthropic Claude).
 * Источник: `hermes_cli/models_catalog_static.py`, `_PROVIDER_MODELS["anthropic"]`.
 */
const ANTHROPIC_MODELS: readonly string[] = Object.freeze([
  "claude-fable-5.1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001",
]);

/** Статический список записей (заморожен; значения ключей отсутствуют). */
const ENTRIES: readonly ProviderRegistryEntry[] = Object.freeze([
  ...OPENAI_API_MODELS.map((model): ProviderRegistryEntry => (
    { model, provider: "openai-api", envKey: "OPENAI_API_KEY" }
  )),
  ...ANTHROPIC_MODELS.map((model): ProviderRegistryEntry => (
    { model, provider: "anthropic", envKey: "ANTHROPIC_API_KEY" }
  )),
]);

/** Возвращает копию всех записей реестра. */
export function listSupportedModels(): ProviderRegistryEntry[] {
  return ENTRIES.map((entry) => ({ ...entry }));
}

/**
 * Ищет запись по имени модели. `default` (legacy-путь без явного выбора)
 * не является built-in моделью и не резолвится; для неизвестных моделей —
 * `undefined`.
 */
export function resolveProviderForModel(model: string): ProviderRegistryEntry | undefined {
  if (model === "default") return undefined;
  return ENTRIES.find((entry) => entry.model === model);
}

/**
 * Проверяет поддержку модели реестром. `default` не бросает (обратная
 * совместимость legacy-пути); для неизвестных моделей бросает
 * `Error("RUN_REQUEST_MODEL_UNSUPPORTED")`.
 */
export function assertSupportedModel(model: string): void {
  if (model !== "default" && !resolveProviderForModel(model)) {
    throw new Error("RUN_REQUEST_MODEL_UNSUPPORTED");
  }
}
