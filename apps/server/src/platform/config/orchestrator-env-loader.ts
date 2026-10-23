/**
 * Загрузчик `.env` Ebb из домашнего каталога оркестратора (`EBB_ORCHESTRATOR_HOME/.env`).
 *
 * Контракт:
 * - путь к файлу резолвится через существующий `resolveOrchestratorHome`;
 * - чтение строго по allowlist имён, переданных в `envKeyNames`; неизвестные
 *   ключи игнорируются;
 * - если файл отсутствует — возвращается пустой объект;
 * - приоритет: если переменная уже присутствует в `process.env`, её значение не
 *   перезаписывается значением из `.env` (`process.env` выигрывает);
 * - значения возвращаются только для ключей, присутствующих в `.env` или
 *   `process.env` (в пределах allowlist);
 * - ошибка парсинга `.env` — fail-closed: бросается `Error('ORCHESTRATOR_ENV_PARSE_FAILED')`.
 *
 * Файл пользовательского Hermes (`~/.hermes/.env`, auth/config) не читается;
 * наружу экспортируются только allowlist-имена.
 */

import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Platform } from "./app-config.js";
import { resolveOrchestratorHome } from "../home/orchestrator-home.js";

/** Код ошибки парсинга `.env` оркестратора (fail-closed). */
const ORCHESTRATOR_ENV_PARSE_FAILED = "ORCHESTRATOR_ENV_PARSE_FAILED";

/**
 * Выбирает реализацию `join` для целевой платформы (аналогично
 * `orchestrator-home.ts`).
 */
function platformJoin(platform: Platform): (a: string, b: string) => string {
  return platform === "win32" ? win32.join : posix.join;
}

/** Проверяет, что ошибка Node — «файл не найден» (ENOENT). */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Минимальный парсер `.env`.
 *
 * - Строка вида `KEY=VALUE`; пробелы вокруг `=` убираются;
 * - значение обрезается, обрамляющие кавычки (`"` / `'`) снимаются;
 * - пустые строки и строки-комментарии (`#...`) игнорируются;
 * - строка без `=` или с пустым ключом считается битой — бросается
 *   `ORCHESTRATOR_ENV_PARSE_FAILED` (fail-closed).
 */
function parseEnvFile(raw: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(ORCHESTRATOR_ENV_PARSE_FAILED);
    }

    const key = trimmed.slice(0, eqIndex).trim();
    if (key === "") {
      throw new Error(ORCHESTRATOR_ENV_PARSE_FAILED);
    }

    let value = trimmed.slice(eqIndex + 1).trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    entries.set(key, value);
  }

  return entries;
}

/**
 * Загружает эффективную env-конфигурацию оркестратора из
 * `EBB_ORCHESTRATOR_HOME/.env`.
 *
 * @param envKeyNames Allowlist имён переменных, которые разрешено читать.
 * @returns Запись ключ → значение только для allowlist-имён, присутствующих
 *   в `.env` или в `process.env` (приоритет у `process.env`).
 * @throws {Error} `ORCHESTRATOR_ENV_PARSE_FAILED` при битой строке `.env`;
 *   ошибка резолва домашнего каталога пробрасывается как есть.
 */
export function loadOrchestratorEnv(envKeyNames: readonly string[]): Record<string, string> {
  const platform: Platform = process.platform === "win32" ? "win32" : "linux";
  const joinFn = platformJoin(platform);
  const home = resolveOrchestratorHome(process.env, platform);
  const envFilePath = joinFn(home.root, ".env");

  let raw: string;
  try {
    raw = readFileSync(envFilePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return {};
    }
    throw error;
  }

  const entries = parseEnvFile(raw);

  const result: Record<string, string> = {};
  for (const key of envKeyNames) {
    const processValue = process.env[key];
    const fileValue = entries.get(key);
    if (processValue !== undefined) {
      result[key] = processValue;
    } else if (fileValue !== undefined) {
      result[key] = fileValue;
    }
  }
  return result;
}
