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

export class EnvironmentBuilder {
  /**
   * Get the base platform environment. Only minimal variables required for
   * launching approved executables are included (PATH and platform-specific base variables).
   */
  private getBaseEnv(): Record<string, string> {
    const base: Record<string, string> = {};

    // Always include PATH for executable resolution
    if (process.env.PATH) {
      base.PATH = process.env.PATH;
    }

    return base;
  }

  /**
   * Build an isolated environment for subprocess execution.
   * 
   * @param options - Configuration for environment building
   * @returns A minimal, isolated environment object
   */
  build(options: BuildEnvOptions): Record<string, string> {
    const env: Record<string, string> = {};

    // Start with platform baseline variables
    const baseEnv = this.getBaseEnv();
    
    // Only include allowlisted base variables (unless overridden by injected)
    for (const key of options.allowlist) {
      if (baseEnv[key] && !options.injected[key]) {
        env[key] = baseEnv[key];
      }
    }

    // Add explicitly injected variables (scoped injection) - these take precedence
    for (const [key, value] of Object.entries(options.injected)) {
      env[key] = value;
    }

    return env;
  }
}
