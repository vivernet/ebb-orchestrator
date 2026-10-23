/**
 * Учёт токенов по бакетам (tokenAccounting).
 *
 * Модуль предоставляет точный детерминированный токенизатор {@link countTokens}
 * и аддитивный учёт токенов по источникам контекста ({@link TokenSourceType}).
 * Учёт ведётся на уровне токенов, а не оценкой по байтам: значения бакетов
 * всегда являются точным результатом токенизатора для соответствующих текстов.
 *
 * Инвариант аддитивности: если части текста разрезаны ТОЛЬКО на границах
 * токенов (например, между источниками контекста), то сумма бакетов совпадает
 * со счётом конкатенации этих частей. Разрез внутри токена склеивает токены
 * и меняет счёт — разделение на бакеты должно проходить по границам токенов.
 *
 * Модуль не связан с persisted-манифестом: точный размер токенов при
 * подготовке контекста остаётся равен `null` (правило «initial token size =
 * NULL»), а учёт используется только для эфемерных триггеров компрессии.
 */

import type { Message } from "../../context/context-types.js";

/** Источник токенов в контексте агента. */
export type TokenSourceType =
  | "content"
  | "fileContext"
  | "toolCalls"
  | "thoughtSignature"
  | "reasoning"
  | "toolDefinition";

/** Все поддерживаемые источники токенов в фиксированном порядке учёта. */
const TOKEN_SOURCE_TYPES: readonly TokenSourceType[] = [
  "content",
  "fileContext",
  "toolCalls",
  "thoughtSignature",
  "reasoning",
  "toolDefinition",
];

/**
 * Учёт токенов по источникам для всего контекста.
 * Каждое поле — неотрицательное целое число точных токенов источника.
 */
export interface InputTokenBuckets {
  /** Токены основного содержимого сообщений. */
  readonly content: number;
  /** Токены содержимого файлов контекста. */
  readonly fileContext: number;
  /** Токены вызовов инструментов. */
  readonly toolCalls: number;
  /** Токены подписи мыслительного процесса. */
  readonly thoughtSignature: number;
  /** Токены рассуждений. */
  readonly reasoning: number;
  /** Токены определений инструментов. */
  readonly toolDefinition: number;
}

/**
 * Разбивка токенов одного сообщения контекста по источникам.
 * `messageIndex` — порядковый номер сообщения в сессии; `buckets` — точный
 * учёт токенов этого сообщения по источникам.
 */
export interface MessageTokenBreakdown {
  /** Порядковый номер сообщения в сессии. */
  readonly messageIndex: number;
  /** Токены сообщения по источникам. */
  readonly buckets: InputTokenBuckets;
}

/**
 * Один символ скриптов без пробелов (CJK): каждый такой символ считается
 * отдельным токеном, как и в распространённых BPE-токенизаторах.
 */
const STANDALONE_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/** Символ слова: буквы, цифры, подчёркивание и комбинируемые метки. */
const WORD_CHAR = /^[\p{L}\p{N}_\p{M}]$/u;

/** Пробельные символы: разделители, токены не образуют. */
const WHITESPACE = /^\s$/u;

/**
 * Точный детерминированный подсчёт токенов текста.
 *
 * Правила токенизации:
 * - максимальный подряд символов слова (`\p{L}`, `\p{N}`, `_`, `\p{M}`)
 *   образует один токен;
 * - каждый символ скриптов без пробелов (CJK) — отдельный токен;
 * - каждый символ пунктуации/символ — отдельный токен;
 * - пробельные символы — разделители, токены не образуют.
 *
 * Результат аддитивен по разрезам на границах токенов: для частей,
 * разделённых по границам токенов, сумма счётов частей равна счёту
 * конкатенации. Разрез внутри токена склеивает токены и меняет счёт.
 *
 * @param text Текст для подсчёта.
 * @returns Точное число токенов текста.
 */
export function countTokens(text: string): number {
  let tokens = 0;
  let inWord = false;
  for (const ch of text) {
    if (WHITESPACE.test(ch)) {
      inWord = false;
      continue;
    }
    if (STANDALONE_SCRIPT.test(ch)) {
      tokens += 1;
      inWord = false;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      if (!inWord) {
        tokens += 1;
        inWord = true;
      }
      continue;
    }
    tokens += 1;
    inWord = false;
  }
  return tokens;
}

/**
 * Проверяет значение бакета: неотрицательное безопасное целое.
 * Нарушение означает повреждённый учёт и отвергается сразу.
 *
 * @param value Проверяемое значение.
 * @param source Источник токенов для диагностики.
 * @throws {TypeError} Если значение не является неотрицательным целым.
 */
function assertValidBucketCount(value: number, source: TokenSourceType): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Token bucket "${source}" must be a non-negative safe integer.`);
  }
}

/**
 * Суммарное число токенов контекста по бакетам.
 * Точная сумма полей {@link InputTokenBuckets}; значения должны быть
 * неотрицательными безопасными целыми.
 *
 * @param buckets Учёт токенов по источникам.
 * @returns Суммарное число токенов.
 * @throws {TypeError} Если любое значение бакета некорректно.
 */
export function countContextTokens(buckets: InputTokenBuckets): number {
  let total = 0;
  for (const source of TOKEN_SOURCE_TYPES) {
    assertValidBucketCount(buckets[source], source);
    total += buckets[source];
  }
  return total;
}

/**
 * Суммирует бакеты поэлементно.
 * Позволяет накапливать учёт по нескольким источникам/сообщениям без потери
 * разбивки. Без аргументов возвращает нулевые бакеты.
 *
 * @param buckets Наборы бакетов для суммирования.
 * @returns Поэлементная сумма всех аргументов.
 * @throws {TypeError} Если любое значение бакета некорректно.
 */
export function addTokenBuckets(...buckets: readonly InputTokenBuckets[]): InputTokenBuckets {
  const result = {} as Record<TokenSourceType, number>;
  for (const source of TOKEN_SOURCE_TYPES) {
    let total = 0;
    for (const entry of buckets) {
      assertValidBucketCount(entry[source], source);
      total += entry[source];
    }
    result[source] = total;
  }
  return result;
}

/**
 * Разбивка токенов одного сообщения по источникам.
 * Всё содержимое сообщения относится к источнику `content`; остальные
 * источники нулевые. `messageIndex` фиксирован равным 0 — функция применима
 * к одиночному сообщению; для последовательностей сообщений номер присваивает
 * вызывающий код.
 *
 * @param message Сообщение контекста.
 * @returns Точная разбивка токенов сообщения по источникам.
 */
export function countMessageTokens(message: Message): MessageTokenBreakdown {
  return {
    messageIndex: 0,
    buckets: {
      content: countTokens(message.content),
      fileContext: 0,
      toolCalls: 0,
      thoughtSignature: 0,
      reasoning: 0,
      toolDefinition: 0,
    },
  };
}
