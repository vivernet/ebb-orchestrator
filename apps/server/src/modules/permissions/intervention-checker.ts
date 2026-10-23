import { ActionId, PermissionDecision } from './permission-types.js';
import { DEFAULT_SECURITY_BLACKLIST } from './default-security-blacklist.js';

/** Тип matcher'а правила security blacklist. */
export type InterventionMatcherType = 'exact' | 'prefix' | 'wildcard';

/** Описание matcher'а: сравнивает каноническую строку команды с pattern'ом. */
export interface InterventionMatcher {
  type: InterventionMatcherType;
  pattern: string;
}

/** Константное правило security blacklist: только `ActionId.CommandExec`. */
export interface InterventionRule {
  /** Уникальный стабильный ID правила. */
  id: string;
  /** Действие, к которому применяется правило (всегда `command.exec`). */
  action: ActionId.CommandExec;
  /** Matcher, применяемый к канонической строке команды. */
  matcher: InterventionMatcher;
  /** Стабильный код причины блокировки (равен `id` в source каталоге). */
  reasonCode: string;
}

/** Вектор команды для проверки: basename executable и нормализованные argv. */
export interface CommandVector {
  executable: string;
  argv: readonly string[];
}

const MAX_PATTERN_LENGTH = 256;
const MAX_CANDIDATE_UTF8_BYTES = 8192;

const MATCHER_TYPES: ReadonlySet<InterventionMatcherType> = new Set(['exact', 'prefix', 'wildcard']);

const BLOCKED_REASON_PREFIX = 'Command execution blocked by security blacklist:';

/** Приводит строку к ASCII lower-case (A–Z → a–z); остальные символы не меняются. */
function toAsciiLower(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[index];
  }
  return out;
}

/**
 * Извлекает basename executable по `/` и `\`, приводит его к ASCII lower-case
 * и удаляет суффикс `.exe` (без учёта регистра).
 */
function executableBasename(executable: string): string {
  const parts = executable.split(/[\\/]/u);
  let name = parts[parts.length - 1] ?? '';
  name = toAsciiLower(name);
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  return name;
}

/** Строит каноническую строку `JSON.stringify([executableBasename, ...argv])` (NFKC). */
function buildCanonical(executable: string, argv: readonly string[]): string {
  return JSON.stringify([executableBasename(executable), ...argv.map((arg) => arg.normalize('NFKC'))]);
}

/** Возвращает длину строки в UTF-8 байтах. */
function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Детерминированный wildcard matcher без `RegExp`.
 * `*` совпадает с любой последовательностью (включая пустую), `?` — ровно с
 * одним символом; остальные символы литеральны. Худшая сложность —
 * `O(patternLength × vectorLength)`.
 */
function matchesWildcard(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starPatternIndex = -1;
  let starValueIndex = 0;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === '?' || pattern[patternIndex] === value[valueIndex])) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starPatternIndex = patternIndex;
      patternIndex += 1;
      starValueIndex = valueIndex;
    } else if (starPatternIndex !== -1) {
      patternIndex = starPatternIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

/** Проверяет, что matcher совпадает с канонической строкой. */
function matchesPattern(matcher: InterventionMatcher, canonical: string): boolean {
  switch (matcher.type) {
    case 'exact':
      return canonical === matcher.pattern;
    case 'prefix':
      return canonical.startsWith(matcher.pattern);
    case 'wildcard':
      return matchesWildcard(matcher.pattern, canonical);
    default:
      return false;
  }
}

/** Валидирует вектор команды: обязательные строковые поля, argv — массив строк. */
function isValidCommandVector(args: CommandVector | null | undefined): args is CommandVector {
  if (!args || typeof args !== 'object') return false;
  if (typeof args.executable !== 'string' || args.executable.length === 0) return false;
  if (!Array.isArray(args.argv)) return false;
  return args.argv.every((arg) => typeof arg === 'string');
}

/**
 * Детерминированный проверяющий security blacklist.
 *
 * Matcher применяется только к `ActionId.CommandExec`; каноническая строка
 * строится как `JSON.stringify([executableBasename, ...argv])`. Wildcard
 * реализуется детерминированным алгоритмом без `RegExp` с худшей сложностью
 * `O(patternLength × vectorLength)`. Отсутствующие или некорректные поля
 * блокируются (fail closed).
 */
export class InterventionChecker {
  private readonly rules: readonly InterventionRule[];

  /**
   * Создаёт проверяющий с заданным каталогом правил.
   * @param rules Каталог правил (по умолчанию — фиксированный source каталог).
   */
  constructor(rules: readonly InterventionRule[] = DEFAULT_SECURITY_BLACKLIST) {
    this.validateRules(rules);
    this.rules = rules;
  }

  /**
   * Проверяет вектор команды против каталога.
   * @param action Действие (правила применяются только к `command.exec`).
   * @param args Вектор команды: executable и argv.
   * @returns Решение: `ABSOLUTE_DENY` при совпадении или malformed векторе,
   *   иначе `ALLOW`.
   */
  evaluate(action: ActionId, args?: CommandVector | null): { decision: PermissionDecision; reason: string } {
    if (action !== ActionId.CommandExec) {
      return { decision: PermissionDecision.ALLOW, reason: 'Security blacklist applies only to command.exec.' };
    }

    if (!isValidCommandVector(args)) {
      return { decision: PermissionDecision.ABSOLUTE_DENY, reason: `${BLOCKED_REASON_PREFIX} malformed command vector.` };
    }

    const canonical = buildCanonical(args.executable, args.argv);
    if (byteLengthUtf8(canonical) > MAX_CANDIDATE_UTF8_BYTES) {
      return { decision: PermissionDecision.ABSOLUTE_DENY, reason: `${BLOCKED_REASON_PREFIX} candidate exceeds the size limit.` };
    }

    for (const rule of this.rules) {
      if (rule.action !== action) continue;
      if (matchesPattern(rule.matcher, canonical)) {
        return { decision: PermissionDecision.ABSOLUTE_DENY, reason: `${BLOCKED_REASON_PREFIX} ${rule.reasonCode}.` };
      }
    }

    return { decision: PermissionDecision.ALLOW, reason: 'No security blacklist rule matched.' };
  }

  private validateRules(rules: readonly InterventionRule[]): void {
    if (!Array.isArray(rules)) throw new Error('Invalid security blacklist rule catalogue');
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') throw new Error('Invalid security blacklist rule');
      if (typeof rule.id !== 'string' || rule.id.length === 0) throw new Error('Invalid security blacklist rule id');
      if (rule.action !== ActionId.CommandExec) throw new Error('Security blacklist rules apply only to command.exec');
      if (!rule.matcher || typeof rule.matcher !== 'object') throw new Error('Invalid security blacklist matcher');
      if (!MATCHER_TYPES.has(rule.matcher.type)) throw new Error(`Invalid security blacklist matcher type: ${String(rule.matcher.type)}`);
      if (typeof rule.matcher.pattern !== 'string' || rule.matcher.pattern.length === 0 || rule.matcher.pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error('Invalid security blacklist matcher pattern');
      }
      if (typeof rule.reasonCode !== 'string' || rule.reasonCode.length === 0) throw new Error('Invalid security blacklist reasonCode');
    }
  }
}
