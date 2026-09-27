/**
 * Уровня приложения configuration types shared across the server.
 */

export type Platform = "linux" | "darwin" | "win32";

/**
 * Проверяет строковое значение платформы до выбора платформозависимого пути.
 * Поддерживаются только Linux, macOS и Windows; неизвестное значение считается ошибкой конфигурации.
 */
export function validatePlatform(value: string): Platform {
  if (value === "linux" || value === "darwin" || value === "win32") return value;
  throw new Error(`Неподдерживаемая платформа «${value}». Допустимы: linux, darwin, win32.`);
}
