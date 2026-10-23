/**
 * Типизированная валидация env-конфигурации сервера (E4, fail-fast).
 *
 * Валидация выполняется на границе чтения окружения: `parseEnvConfig`
 * разбирает `process.env` через zod-схему и при первой невалидной или
 * недостающей обязательной переменной выбрасывает `EnvValidationError`
 * до запyска сервера.
 *
 * Схема покрывает известные безопасные переменные сервера:
 * - `PORT` — порт HTTP-сервера (по умолчанию 3000);
 * - `EBB_ORCHESTRATOR_HOME` — домашний каталог оркестратора (необязательная);
 * - `HOME` / `USERPROFILE` — платформенные fallback домашнего каталога;
 * - `EBB_ORCHESTRATOR_VERSION` — версия приложения (по умолчанию "development").
 *
 * Неизвестные переменные окружения разрешены и игнорируются, чтобы не ломать
 * интеграцию с внешними средами (Node, ОС, CI).
 */

import { z } from "zod";
import { ConfigValidationError } from "./config-errors.js";

/** Пара «путь к переменной + сообщение» без значений, чтобы не утекать данные в ошибках. */
export interface EnvValidationIssue {
  /** Путь к проблемной переменной в записи окружения (например, ["PORT"]). */
  readonly path: readonly string[];
  /** Сообщение о нарушении схемы без включения исходного значения. */
  readonly message: string;
}

/**
 * Ошибка валидации env-конфигурации.
 *
 * `message` и `issues` содержат только имена переменных и сообщения схемы;
 * исходные значения окружения в ошибку не попадают.
 */
export class EnvValidationError extends ConfigValidationError {
  constructor(
    message: string,
    public override readonly issues: readonly EnvValidationIssue[],
  ) {
    super(message, issues);
    this.name = "EnvValidationError";
  }
}

/**
 * Нормализует необязательную строковую переменную окружения:
 * отсутствующее или пустое (в т.ч. пробельное) значение становится `undefined`,
 * значение с пробелами по краям обрезается.
 */
function optionalPathField(message: string): z.ZodType<string | undefined> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1, message).optional(),
  );
}

/**
 * Схема окружения сервера.
 *
 * Поле `PORT` обязательное: отсутствие переменной считается ошибкой
 * конфигурации (fail-fast). Пустое значение трактуется как отсутствующее
 * и заменяется умолчанием 3000. Умолчания и fallback домашнего каталога
 * применяются лаунчером (см. main.ts), не меняя контракт загрузки.
 */
export const ServerEnvSchema = z.object({
  PORT: z
    .union([z.literal(""), z.string().trim().regex(/^[0-9]+$/, "PORT должен быть целым числом")])
    .transform((value) => (value === "" ? 3000 : Number(value)))
    .pipe(z.number().int("PORT должен быть целым числом").min(1, "PORT должен быть не меньше 1").max(65535, "PORT должен быть не больше 65535")),
  EBB_ORCHESTRATOR_HOME: optionalPathField("EBB_ORCHESTRATOR_HOME не должен быть пустым"),
  HOME: optionalPathField("HOME не должен быть пустым"),
  USERPROFILE: optionalPathField("USERPROFILE не должен быть пустым"),
  EBB_ORCHESTRATOR_VERSION: z
    .string()
    .trim()
    .min(1, "EBB_ORCHESTRATOR_VERSION не должен быть пустым")
    .default("development"),
});

/** Типизированный результат валидации окружения сервера. */
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/**
 * Валидирует запись окружения и возвращает типизированную конфигурацию.
 *
 * @param input Запись окружения (обычно `process.env`).
 * @returns Нормализованная и валидированная конфигурация.
 * @throws {EnvValidationError} При невалидном или недостающем обязательном значении.
 */
export function parseEnvConfig(input: Record<string, string | undefined>): ServerEnv {
  const result = ServerEnvSchema.safeParse(input);
  if (!result.success) {
    const issues: readonly EnvValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    }));
    const summary = issues.map((issue) => issue.path.join(".")).filter(Boolean).join(", ");
    throw new EnvValidationError(`Environment configuration validation failed: ${summary || "unknown"}`, issues);
  }
  return result.data;
}
