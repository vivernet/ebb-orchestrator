/**
 * Hermes парсер сессия ID - извлекает сессия ID из hermes результат.
 */

/**
 * Extracts сессия ID из hermes stdout результат.
 *
 * Этот session ID appears in the format "session: <id>" in the output.
 * Возвращает null, если no корректный сессия ID является found.
 */
export function parseSessionId(stdout: string): string | null {
  const sessionPattern = /session:\s*([a-zA-Z0-9_-]+)/;
  const match = stdout.match(sessionPattern);
  return match?.[1] ?? null;
}

/**
 * Проверяет, stdout indicates Объект успешный запуск сессия.
 */
export function hasValidSessionStart(stdout: string): boolean {
  return parseSessionId(stdout) !== null;
}
