/**
 * EnvironmentBuilder создаёт изолированные переменные окружения для запуска subprocess.
 * Он строит окружение дочернего процесса из небольшого platform baseline и явно ограниченных injected variables.
 * В отличие от традиционного копирования process.env с последующим исключением известных имён,
 * эта реализация сохраняет только переменные, необходимые для поиска и запуска разрешённых executable.
 */

export type BuildEnvOptions = {
  /** Список переменных окружения, сохраняемых из базовой платформы. */
  allowlist: string[];
  /** Явно ограниченные переменные для добавления в окружение выполнения. */
  injected: Record<string, string>;
};

/**
 * Реализует security boundary environment-builder; входные данные должны пройти предусмотренные проверки доверия.
 */
export class EnvironmentBuilder {
  /**
   * Возвращает базовое окружение платформы. В него входят только минимальные переменные,
   * необходимые для запуска разрешённых executable (PATH и базовые переменные платформы).
   */
  private getBaseEnv(): Record<string, string> {
    const base: Record<string, string> = {};

    // Всегда включает PATH для поиска executable
    if (process.env.PATH) {
      base.PATH = process.env.PATH;
    }

    return base;
  }

  /**
   * Строит изолированное окружение для запуска subprocess.
   * 
   * @param options Конфигурация построения окружения.
   * @returns Минимальный изолированный объект окружения.
   */
  build(options: BuildEnvOptions): Record<string, string> {
    const env: Record<string, string> = {};

    // Начинает с platform baseline variables
    const baseEnv = this.getBaseEnv();
    
    // Включает только allowlisted base variables, если их не переопределяет injected
    for (const key of options.allowlist) {
      if (baseEnv[key] && !options.injected[key]) {
        env[key] = baseEnv[key];
      }
    }

    // Добавляет явно injected variables (scoped injection); они имеют приоритет
    for (const [key, value] of Object.entries(options.injected)) {
      env[key] = value;
    }

    return env;
  }
}
