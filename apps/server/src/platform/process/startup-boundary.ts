/** Зависимости границы запуска между настройкой локального пользователя и HTTP-сервером. */
export interface StartupBoundaryDeps {
  /** Проверяет или создаёт локального пользователя; отказ прекращает запуск до workers и listener. */
  ensureLocalUser(): Promise<unknown>;
  /** Запускает lifecycle и workers только после успешной настройки пользователя. */
  startSystem(): Promise<void>;
  /** Открывает HTTP listener только после успешного lifecycle. */
  listen(): Promise<unknown>;
}

/**
 * Последовательно выполняет security-critical startup boundary.
 *
 * Отказ wizard намеренно пробрасывается без вызова workers или HTTP listener;
 * это сохраняет fail-closed семантику первого запуска.
 */
export async function runStartupBoundary(deps: StartupBoundaryDeps): Promise<void> {
  await deps.ensureLocalUser();
  await deps.startSystem();
  await deps.listen();
}
