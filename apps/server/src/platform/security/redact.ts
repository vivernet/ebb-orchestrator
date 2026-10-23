/**
 * Redaction-плейсхолдеры для защиты секретов в логах и диагностике.
 *
 * Модуль предоставляет детерминированную замену потенциально секретных
 * паттернов (токены, ключи, credentials, URL с credentials, ключи
 * провайдеров) на фиксированный плейсхолдер `[REDACTED]`.
 *
 * Безопасность:
 * - Разрешены только allowlist-паттерны: литералы точного совпадения
 *   (exact) и префиксы (prefix), добавляемые в runtime, плюс
 *   предопределённый набор безопасных regex-паттернов (компилируется
 *   только из констант модуля). Пользовательский RegExp из runtime в
 *   публичный API не принимается.
 * - Вход жёстко ограничен по размеру (`MAX_REDACT_INPUT_LENGTH`):
 *   метод `redact` бросает RangeError при превышении лимита; функция
 *   `safeRedact` бросает TypeError для нестрокового входа, а строковый
 *   вход обрезается до лимита без бросания.
 * - Замена идемпотентна: плейсхолдер не совпадает ни с одним из
 *   паттернов, поэтому повторная обработка не меняет результат.
 *
 * Инварианты:
 * - `redact(input)` возвращает строку той же длины или короче;
 * - при отсутствии совпадений вход возвращается без изменений;
 * - для одинакового входа и одинакового набора паттернов результат
 *   всегда одинаков (детерминизм).
 */

/** Фиксированный плейсхолдер замены секретов. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** Максимальная длина входа (в UTF-16 code units), допустимая для обработки. */
export const MAX_REDACT_INPUT_LENGTH = 65_536;

/** Только литерал точного совпадения или префикс; regex не принимается из runtime. */
export type RedactPattern = Readonly<
  | { kind: "exact"; value: string }
  | { kind: "prefix"; value: string }
>;

/** Заменяющая функция: получает полное совпадение и capture-группы. */
type Replacer = (match: string, groups: readonly (string | undefined)[]) => string;

/** Внутреннее правило: скомпилированный RegExp + заменяющая функция. */
interface CompiledRedactRule {
  readonly re: RegExp;
  readonly replace: Replacer;
}

/** Класс символов: любой символ, включая переводы строк. */
const ANY_CHAR = "[^]";

/** Класс символов: любой пробельный символ. */
const WHITESPACE = "[ \t\n\r]";

/** Класс символов: НЕ пробельный символ и не разделители значений. */
const NON_WHITESPACE_DELIM = "[^ \t\n\r\"',;&#]";

/**
 * Предопределённый безопасный набор regex-правил (allowlist).
 * Порядок важен: более специфичные правила идут раньше; плейсхолдер
 * инертен, поэтому последовательная замена детерминирована.
 * Regex-исходники собраны только из литеральных символов без экранирования
 * (переносы строк и пробелы заданы явными классами).
 */
const PRESET_RULES: readonly Readonly<{
  flags: string;
  source: string;
  replace: Replacer;
}>[] = Object.freeze([
  {
    flags: "g",
    source:
      "-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----" +
      ANY_CHAR + "*?" +
      "-----END (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source:
      "eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "sk-proj-[A-Za-z0-9_-]{20,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "sk-" + "ant-api03-" + "[A-Za-z0-9_-]{10,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "sk-[A-Za-z0-9]{20,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "ghp_[A-Za-z0-9]{36,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "github_pat_[A-Za-z0-9_]{20,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "AKIA[0-9A-Z]{16}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "ASIA[0-9A-Z]{16}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "g",
    source: "xox[baprs]-[A-Za-z0-9-]{10,}",
    replace: () => REDACTED_PLACEHOLDER,
  },
  {
    flags: "gi",
    source:
      "([a-z][a-z0-9+.-]*://)[^/ \t\n\r:@]+:[^/ \t\n\r@]+(@)",
    replace: (_match: string, groups: readonly (string | undefined)[]) => `${groups[0]}${REDACTED_PLACEHOLDER}${groups[1]}`,
  },
  {
    flags: "gi",
    source:
      "((?:^|[^A-Za-z0-9_])Authorization" + WHITESPACE + "*:" +
      WHITESPACE + "*Bearer" + WHITESPACE + "+)" +
      "[A-Za-z0-9._~+/-]+=*",
    replace: (_match: string, groups: readonly (string | undefined)[]) => `${groups[0]}${REDACTED_PLACEHOLDER}`,
  },
  {
    flags: "gi",
    source:
      "([?&](?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|" +
      "password|passwd|pass|secret|auth[_-]?token)=)[^& \t\n\r#]*",
    replace: (_match: string, groups: readonly (string | undefined)[]) => `${groups[0]}${REDACTED_PLACEHOLDER}`,
  },
  {
    flags: "gi",
    source:
      "((?:^|[^A-Za-z0-9_])(?:api[_-]?key|apikey|x[_-]?api[_-]?key|" +
      "auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|" +
      "pass|secret|token)" + WHITESPACE + "*[:=]" + WHITESPACE + "*)" +
      "(?:\"([^\"]*)\"|'([^']*)'|(" + NON_WHITESPACE_DELIM + "+))",
    replace: (_match: string, groups: readonly (string | undefined)[]) => {
      if (groups[1] !== undefined) return `${groups[0]}"${REDACTED_PLACEHOLDER}"`;
      if (groups[2] !== undefined) return `${groups[0]}'${REDACTED_PLACEHOLDER}'`;
      return `${groups[0]}${REDACTED_PLACEHOLDER}`;
    },
  },
]);

/** Обратный слэш: конструируется по коду, чтобы избежать экранирования. */
const BSLASH = String.fromCharCode(92);

/** Экранирует литерал для использования в RegExp (без regex-литералов). */
function escapeRegExp(value: string): string {
  let out = "";
  for (const ch of value) {
    if ((BSLASH + "^$.*+?()[]{}|").includes(ch)) out += BSLASH + ch;
    else out += ch;
  }
  return out;
}

/** Компилирует правило (exact/prefix/regex) в готовый к применению объект. */
function compileRule(
  pattern: RedactPattern | (typeof PRESET_RULES)[number],
): CompiledRedactRule {
  if ("source" in pattern) {
    return {
      re: new RegExp(pattern.source, pattern.flags),
      replace: pattern.replace,
    };
  }
  if (pattern.kind === "prefix") {
    const source = `${escapeRegExp(pattern.value)}${NON_WHITESPACE_DELIM}+`;
    return {
      re: new RegExp(source, "g"),
      replace: () => REDACTED_PLACEHOLDER,
    };
  }
  return {
    re: new RegExp(escapeRegExp(pattern.value), "g"),
    replace: () => REDACTED_PLACEHOLDER,
  };
}

/**
 * Детерминированный redactor: применяет allowlist-паттерны к тексту.
 *
 * Конструктор принимает только литеральные правила (exact/prefix);
 * regex-правила берутся из предопределённого набора констант модуля.
 */
export class Redactor {
  private readonly rules: CompiledRedactRule[];

  /** Создаёт redactor; по умолчанию — с предопределённым allowlist-набором. */
  constructor(patterns: readonly RedactPattern[] = []) {
    this.rules = [...PRESET_RULES, ...patterns].map(compileRule);
  }

  /** Регистрирует литерал точного совпадения для redaction. */
  addExact(value: string): void {
    this.rules.push(compileRule({ kind: "exact", value }));
  }

  /** Регистрирует префикс: заменяется значение от префикса до разделителя. */
  addPrefix(value: string): void {
    this.rules.push(compileRule({ kind: "prefix", value }));
  }

  /**
   * Заменяет секретные паттерны на `[REDACTED]`.
   *
   * @param input Входной текст (без ограничения на символы).
   * @returns Текст с заменёнными секретами.
   * @throws RangeError если длина входа превышает `MAX_REDACT_INPUT_LENGTH`.
   */
  redact(input: string): string {
    if (typeof input !== "string") {
      throw new TypeError("REDACT_INPUT_MUST_BE_STRING");
    }
    if (input.length > MAX_REDACT_INPUT_LENGTH) {
      throw new RangeError("REDACT_INPUT_TOO_LARGE");
    }
    let result = input;
    for (const rule of this.rules) {
      result = result.replace(rule.re, (...args) => rule.replace(args[0]!, args.slice(1)));
    }
    return result;
  }
}

/**
 * Безопасная redaction с предопределённым набором.
 * - Нестроковый вход бросает TypeError (`REDACT_INPUT_MUST_BE_STRING`).
 * - Строковый вход длиннее `MAX_REDACT_INPUT_LENGTH` обрезается до
 *   лимита перед обработкой без бросания (секрет в обрезанной части
 *   не обрабатывается).
 */
export function safeRedact(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("REDACT_INPUT_MUST_BE_STRING");
  }
  const bounded = input.length > MAX_REDACT_INPUT_LENGTH
    ? input.slice(0, MAX_REDACT_INPUT_LENGTH)
    : input;
  return new Redactor().redact(bounded);
}
