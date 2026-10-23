const preflightCodes = new Set([
  'HERMES_LAUNCHER_NOT_FOUND', 'HERMES_LAUNCHER_AMBIGUOUS', 'HERMES_INSTALL_LAYOUT_UNSUPPORTED',
  'HERMES_RUNTIME_LAYOUT_UNSUPPORTED', 'HERMES_PATH_IDENTITY_INVALID', 'HERMES_PLATFORM_UNSUPPORTED',
  'HERMES_CONFIG_HOME_UNSAFE', 'HERMES_RUN_SELECTION_BINDING_MISMATCH', 'HERMES_RUN_SELECTION_UNAVAILABLE',
  'HERMES_RUNTIME_IDENTITY_CHANGED', 'HERMES_RUN_PREFLIGHT_REQUIRED',
  'NATIVE_HELPER_GATE_UNAVAILABLE', 'NATIVE_HELPER_INTEGRITY_ANCHOR_UNAVAILABLE',
  'NATIVE_HELPER_INTEGRITY_ANCHOR_INVALID', 'NATIVE_HELPER_PATH_INVALID', 'NATIVE_HELPER_UNAVAILABLE',
  'NATIVE_HELPER_PATH_UNSAFE', 'NATIVE_HELPER_INTEGRITY_MISMATCH', 'NATIVE_HELPER_LAUNCH_INPUT_INVALID',
  'NATIVE_HELPER_PLATFORM_UNSUPPORTED', 'NATIVE_HELPER_LAUNCH_OPTIONS_INVALID',
]);

const spawnErrnoCodes = new Map([
  ['EACCES', 'NATIVE_HELPER_SPAWN_EACCES'],
  ['EPERM', 'NATIVE_HELPER_SPAWN_EPERM'],
  ['ENOENT', 'NATIVE_HELPER_SPAWN_ENOENT'],
  ['EINVAL', 'NATIVE_HELPER_SPAWN_EINVAL'],
  ['ETIMEDOUT', 'NATIVE_HELPER_SPAWN_ETIMEDOUT'],
]);

/**
 * Сворачивает ограниченную цепочку ошибок в один безопасный диагностический код.
 * Ни текст ошибки, ни путь, ни параметры запуска не возвращаются вызывающему коду.
 *
 * @param {unknown} error Возможная ошибка preflight и её ограниченная cause-цепочка.
 * @returns {string} Только фиксированный код из локального allowlist.
 */
export function classifyTask5cPreflightError(error) {
  let current = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (preflightCodes.has(current.message)) return current.message;
    if (current.message.startsWith('NATIVE_HELPER_GATE_FAIL:')) return 'NATIVE_HELPER_GATE_FAIL';
    const errno = typeof current.code === 'string' ? spawnErrnoCodes.get(current.code) : undefined;
    if (errno) return errno;
    current = current.cause;
  }
  return 'UNCLASSIFIED';
}
