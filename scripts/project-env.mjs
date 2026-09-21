import { existsSync, readFileSync } from 'node:fs';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Разбирает минимальный dotenv-формат без раскрытия значений в логах.
 * Поддерживает комментарии, `export` и одинарные/двойные кавычки.
 */
export function parseDotEnv(content) {
  const values = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).trim();
    if (!ENV_NAME.test(name)) continue;
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

/** Загружает локальный `.env`, если он существует. */
export function loadProjectEnv({ sourceEnv = process.env, envFilePath } = {}) {
  const fileValues = envFilePath && existsSync(envFilePath)
    ? parseDotEnv(readFileSync(envFilePath, 'utf8'))
    : {};
  return mergeProjectEnv(fileValues, sourceEnv);
}

/** Объединяет environment, предпочитая явно заданные значения project `.env`. */
export function mergeProjectEnv(fileValues, sourceEnv = process.env) {
  return { ...sourceEnv, ...fileValues };
}
