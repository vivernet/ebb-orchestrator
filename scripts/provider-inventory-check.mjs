#!/usr/bin/env node
/**
 * Проверка состава локального каталога AI-провайдеров Ebb против
 * закреплённого источника LobeHub (plan-24, Task 0).
 *
 * Контракт:
 *  - EXPECTED — 86 provider ID из enum `ModelProvider` закреплённого коммита
 *    LobeHub `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`
 *    (`packages/model-bank/src/const/modelProvider.ts`).
 *  - LOCAL — набор ID из `apps/server/src/modules/runtime/providers/provider-catalog.ts`
 *    (создаётся в Task 1). Пока файл отсутствует, используется fallback-baseline
 *    из `hermes-provider-registry.ts`: `openai-api` → `openai`, `anthropic` → `anthropic`.
 *  - Вывод: счётчики, отсутствующие ID (sorted), дубликаты, лишние ID.
 *  - Exit code 1, если missing или duplicates непусты.
 *
 * Скрипт не читает секреты, не обращается к сетям и не обращается к профилю
 * пользователя Hermes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const CATALOG_PATH = join(
  REPO_ROOT,
  'apps/server/src/modules/runtime/providers/provider-catalog.ts',
);
const REGISTRY_PATH = join(
  REPO_ROOT,
  'apps/server/src/modules/runtime/hermes/hermes-provider-registry.ts',
);

/** Source pin LobeHub (plan-24, Authority): commit d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1. */
const LOBEHUB_SOURCE_PIN = 'd1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1';

/**
 * Ожидаемый набор из 86 provider ID — enum `ModelProvider` закреплённого
 * коммита LobeHub (`packages/model-bank/src/const/modelProvider.ts`).
 * Порядок не значим; набор фиксирован и не должен меняться без пересверки
 * с источником.
 */
const EXPECTED_PROVIDER_IDS = Object.freeze([
  'ai21', 'ai302', 'ai360', 'aihubmix', 'akashchat', 'antgroup', 'anthropic',
  'azure', 'azureai', 'baichuan', 'bailiancodingplan', 'bedrock', 'bfl',
  'cerebras', 'chatgpt', 'cloudflare', 'cohere', 'cometapi', 'comfyui',
  'deepseek', 'fal', 'fireworksai', 'giteeai', 'github', 'githubcopilot',
  'glmcodingplan', 'google', 'groq', 'higress', 'huggingface', 'hunyuan',
  'infiniai', 'internlm', 'jina', 'kimicodingplan', 'lmstudio', 'lobehub',
  'longcat', 'meta', 'minimax', 'minimaxcodingplan', 'mistral', 'modelscope',
  'moonshot', 'nebius', 'newapi', 'novita', 'nvidia', 'ollama',
  'ollamacloud', 'openai', 'opencodecodingplan', 'opencodezen', 'openrouter',
  'perplexity', 'ppio', 'qiniu', 'qwen', 'replicate', 'sambanova',
  'search1api', 'sensenova', 'siliconcloud', 'spark', 'stepfun', 'straico',
  'streamlake', 'supergrok', 'taichu', 'tencentcloud', 'togetherai',
  'unsloth', 'upstage', 'v0', 'vercelaigateway', 'vertexai', 'vllm',
  'volcengine', 'volcenginecodingplan', 'wenxin', 'xai', 'xiaomimimo',
  'xinference', 'zenmux', 'zeroone', 'zhipu',
]);

/** Fallback-маппинг имён провайдеров реестра Hermes в ID каталога LobeHub. */
const HERMES_REGISTRY_PROVIDER_MAP = Object.freeze({
  'openai-api': 'openai',
  anthropic: 'anthropic',
});

function sortUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Читает локальный набор provider ID.
 * Сначала — `provider-catalog.ts` (Task 1). Если файла нет — fallback-baseline
 * из `hermes-provider-registry.ts` через маппинг HERMES_REGISTRY_PROVIDER_MAP.
 * @returns {{ source: string, ids: string[], raw: string[] }}
 */
function readLocalProviderIds() {
  if (existsSync(CATALOG_PATH)) {
    const source = readFileSync(CATALOG_PATH, 'utf8');
    const raw = [...source.matchAll(/\bid:\s*['"]([a-z0-9_-]+)['"]/g)].map((m) => m[1]);
    return { source: CATALOG_PATH, ids: sortUnique(raw), raw };
  }
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`Ни provider-catalog.ts, ни hermes-provider-registry.ts не найдены в ${REPO_ROOT}`);
  }
  const source = readFileSync(REGISTRY_PATH, 'utf8');
  const rawProviders = [...source.matchAll(/provider:\s*"([^"]+)"/g)].map((m) => m[1]);
  const raw = rawProviders.map((provider) => HERMES_REGISTRY_PROVIDER_MAP[provider] ?? provider);
  return { source: REGISTRY_PATH, ids: sortUnique(raw), raw };
}

function duplicatesOf(raw) {
  const seen = new Map();
  for (const id of raw) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

function main() {
  const { source, ids, raw } = readLocalProviderIds();
  const expectedSet = new Set(EXPECTED_PROVIDER_IDS);
  const localSet = new Set(ids);

  const missing = sortUnique([...expectedSet].filter((id) => !localSet.has(id)));
  const duplicates = duplicatesOf(raw);
  const extras = sortUnique([...localSet].filter((id) => !expectedSet.has(id)));

  const lines = [];
  lines.push('=== Проверка инвентаризации провайдеров (plan-24, Task 0) ===');
  lines.push(`Исходник (pinned LobeHub ${LOBEHUB_SOURCE_PIN}): ModelProvider enum, ${EXPECTED_PROVIDER_IDS.length} ID`);
  lines.push(`Локальный источник: ${source}`);
  lines.push(`Ожидаемое количество ID: ${EXPECTED_PROVIDER_IDS.length}`);
  lines.push(`Локальное количество ID (уникальных): ${ids.length}`);
  lines.push(`Отсутствует (missing): ${missing.length}`);
  lines.push(`Дубликаты (duplicates): ${duplicates.length}`);
  lines.push(`Лишние (extras): ${extras.length}`);
  if (missing.length > 0) lines.push(`Missing (sorted): ${missing.join(', ')}`);
  else lines.push('Missing (sorted): (нет)');
  if (duplicates.length > 0) lines.push(`Duplicates (sorted): ${duplicates.join(', ')}`);
  else lines.push('Duplicates (sorted): (нет)');
  if (extras.length > 0) lines.push(`Extras (sorted): ${extras.join(', ')}`);
  else lines.push('Extras (sorted): (нет)');

  const failed = missing.length > 0 || duplicates.length > 0;
  lines.push(failed ? 'Summary: FAIL — инвентаризация неполная или содержит дубликаты' : 'Summary: PASS — 86/86, без missing/duplicates');
  console.log(lines.join('\n'));

  process.exitCode = failed ? 1 : 0;
}

main();
