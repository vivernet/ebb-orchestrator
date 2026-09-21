import { GitReconciler } from "../../modules/git/git-reconciler.js";

/**
 * Запуск reconciler – collects and runs reconciliation functions at boot.
 *
 * Каждый reconciler is called in registration order.  Errors are captured
 * чтобы ошибка одного reconciler не препятствовала запуску следующих.
 */

export interface StartupReport {
  /** Количество вызванных reconcilers, включая завершившиеся ошибкой. */
  reconcilersRun: number;
  /** Ошибки, выброшенные отдельными reconcilers. */
  errors: Error[];
}

export interface StartupDegradationStatus {
  set(status: "DEGRADED"): Promise<void>;
}

/**
 * Переводит lifecycle в fail-closed состояние, если reconciliation завершился
 * ошибками. После этого ошибка пробрасывается, чтобы startup не дошёл до READY.
 */
export async function failClosedStartupReconciliation(
  report: StartupReport,
  status: StartupDegradationStatus,
): Promise<void> {
  if (report.errors.length === 0) return;

  await status.set("DEGRADED");
  throw new Error(
    `Startup reconciliation failed: ${report.errors.map((error) => error.message).join("; ")}`,
  );
}

/**
 * Предоставляет публичный контракт модуля startup-reconciler для взаимодействия слоёв приложения.
 */
export class StartupReconciler {
  private readonly reconcilers: Array<() => Promise<void>> = [];
  private gitReconciler: GitReconciler | null = null;

  /**
   * Регистрирует функцию reconciliation для запуска при старте.
   */
  register(fn: () => Promise<void>): void {
    this.reconcilers.push(fn);
  }

  /**
   * Регистрирует Git reconciler для проверки расхождений при старте.
   */
  registerGitReconciler(reconciler: GitReconciler): void {
    this.gitReconciler = reconciler;
    this.register(async () => { await reconciler.reconcile("main"); });
  }

  /**
   * Возвращает зарегистрированный Git reconciler.
   */
  getGitReconciler(): GitReconciler | null {
    return this.gitReconciler;
  }

  /**
   * Выполняет все зарегистрированные reconcilers по порядку.
   *
   * Возвращает {@link StartupReport} с количеством запусков и возникшими ошибками.
   */
  async run(): Promise<StartupReport> {
    const errors: Error[] = [];

    for (const reconciler of this.reconcilers) {
      try {
        await reconciler();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return {
      reconcilersRun: this.reconcilers.length,
      errors,
    };
  }
}
