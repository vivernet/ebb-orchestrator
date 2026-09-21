/**
 * EnvironmentBuilder creates isolated environment variables for subprocess execution.
 * It builds child environments from a small platform baseline plus explicitly scoped injected variables.
 * Unlike the traditional approach of cloning process.env and blacklisting known names,
 * this implementation only preserves variables required to locate/launch approved executables.
 */

export type BuildEnvOptions = {
  /** List of environment variables to preserve from the base platform */
  allowlist: string[];
  /** Explicitly scoped variables to inject into the execution environment */
  injected: Record<string, string>;
};

/**
 * Реализует security boundary environment-builder; входные данные должны пройти предусмотренные проверки доверия.
 */
export class EnvironmentBuilder {
  /**
   * Get the base platform environment. Only minimal variables required for
   * launching approved executables are included (PATH and platform-specific base variables).
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
   * @param options - Configuration for environment building
   * @returns A minimal, isolated environment object
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
