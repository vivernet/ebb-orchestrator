import { GitReconciler } from "../../modules/git/git-reconciler.js";

/**
 * Startup reconciler – collects and runs reconciliation functions at boot.
 *
 * Each reconciler is called in registration order.  Errors are captured
 * so that a failing reconciler does not prevent later ones from running.
 */

export interface StartupReport {
  /** Number of reconcilers that were invoked (including failures). */
  reconcilersRun: number;
  /** Errors thrown by individual reconcilers. */
  errors: Error[];
}

export class StartupReconciler {
  private readonly reconcilers: Array<() => Promise<void>> = [];
  private gitReconciler: GitReconciler | null = null;

  /**
   * Register a reconciliation function to run at startup.
   */
  register(fn: () => Promise<void>): void {
    this.reconcilers.push(fn);
  }

  /**
   * Register the git reconciler to check for drift at startup.
   */
  registerGitReconciler(reconciler: GitReconciler): void {
    this.gitReconciler = reconciler;
    this.register(async () => { await reconciler.reconcile("main"); });
  }

  /**
   * Get the registered git reconciler.
   */
  getGitReconciler(): GitReconciler | null {
    return this.gitReconciler;
  }

  /**
   * Execute all registered reconcilers in order.
   *
   * Returns a {@link StartupReport} summarising how many ran and
   * any errors that occurred.
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
