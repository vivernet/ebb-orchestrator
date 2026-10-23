/**
 * Модуль path-scope: нормализация и ограничение аргументов-путей инструментов.
 *
 * Единый вход для workspace-инструментов: проверяет исходное значение
 * аргумента ДО нативного `path.resolve` (чтобы foreign absolute пути с
 * drive-буквой или UNC не были интерпретированы как относительные имена),
 * затем сохраняет symlink/junction-safe containment существующего `PathResolver`.
 * Никакие канонические пути вне capability-bound workspace (включая `/tmp`)
 * не разрешаются.
 */
import * as path from 'node:path';
import { PathResolver } from './path-resolver.js';

/** Путь канонически разрешается за пределы workspace. */
export const PATH_OUTSIDE_SCOPE = 'PATH_OUTSIDE_SCOPE';

/** Значение не может быть разрешено как путь (не-строка, NUL-байт). */
export const PATH_UNRESOLVABLE = 'PATH_UNRESOLVABLE';

const defaultResolver = new PathResolver();

/**
 * Нормализует строку пути для проверок scope.
 *
 * Удаляет обрамляющие пробелы. На Windows обратные слеши приводятся к
 * прямым (с сохранением drive/UNC-префиксов). На POSIX строка не меняется:
 * обратный слеш там — валидный символ имени файла, и его замена стёрла бы
 * сигнатуру foreign absolute пути (например `C:\outside.txt`), из-за чего
 * он был бы трактован как относительное имя внутри workspace.
 */
export function normalizePathForScope(value: string): string {
  let normalized = value.trim();
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\\/g, '/');
  }
  return normalized;
}

/**
 * Разрешает один аргумент-путь в пределах workspace.
 *
 * @param workspace Корень capability-bound workspace.
 * @param arg Строка пути (недоверенный вход инструмента).
 * @param baseCwd Доверенный внутренний контекст cwd (должен находиться внутри
 *   workspace); по умолчанию — сам workspace.
 * @param resolver Используемый `PathResolver` (по умолчанию общий экземпляр).
 * @returns Канонический абсолютный путь внутри workspace или код ошибки.
 */
export function resolvePathWithScope(
  workspace: string,
  arg: string,
  baseCwd?: string,
  resolver: PathResolver = defaultResolver,
): { ok: true; path: string } | { ok: false; error: string } {
  const normalized = normalizePathForScope(arg);
  if (normalized.includes('\0')) {
    return { ok: false, error: PATH_UNRESOLVABLE };
  }
  if (isForeignAbsolutePath(workspace, normalized)) {
    return { ok: false, error: PATH_OUTSIDE_SCOPE };
  }
  const base = baseCwd ?? workspace;
  const joined = path.resolve(base, normalized);
  const result = resolver.resolveSafePathSync(workspace, joined);
  if (!result.success) {
    if (!resolver.isPathContained(workspace, joined)) {
      return { ok: false, error: PATH_OUTSIDE_SCOPE };
    }
    return { ok: false, error: PATH_UNRESOLVABLE };
  }
  return { ok: true, path: result.path! };
}

/**
 * Проверяет, лежит ли путь внутри workspace после канонизации с учётом
 * symlink/junction resolution. Возвращает true только для канонического пути
 * внутри workspace.
 */
export function isPathWithinScope(workspace: string, target: string, resolver: PathResolver = defaultResolver): boolean {
  return resolver.isPathContained(workspace, target);
}

/**
 * Проводит перечисленные поля аргументов инструмента через
 * `resolvePathWithScope`: значения заменяются каноническими абсолютными путями
 * внутри workspace; остальные поля не меняются. Исходный объект не мутируется.
 *
 * @param workspace Корень capability-bound workspace.
 * @param args Объект аргументов инструмента (не мутируется).
 * @param pathFields Поля, которые являются путями. Отсутствующие поля
 *   пропускаются; не-строковое значение поля отклоняется как
 *   `PATH_UNRESOLVABLE`.
 * @param resolver Используемый `PathResolver` (по умолчанию общий экземпляр).
 */
export function resolveArgsWithScope(
  workspace: string,
  args: Record<string, unknown>,
  pathFields: readonly string[],
  resolver: PathResolver = defaultResolver,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const next: Record<string, unknown> = { ...args };
  for (const field of pathFields) {
    const value = next[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { ok: false, error: PATH_UNRESOLVABLE };
    }
    const resolved = resolvePathWithScope(workspace, value, undefined, resolver);
    if (!resolved.ok) return resolved;
    next[field] = resolved.path;
  }
  return { ok: true, args: next };
}

/**
 * Отклоняет cross-platform absolute вход: drive-буква или UNC против
 * POSIX-workspace. Для Windows-workspace разрешение полностью отдаётся
 * `PathResolver` (win32-семантика).
 */
function isForeignAbsolutePath(workspace: string, target: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(workspace) || workspace.startsWith('\\\\')) {
    return false;
  }
  return /^[A-Za-z]:/.test(target) || target.startsWith('\\\\');
}
