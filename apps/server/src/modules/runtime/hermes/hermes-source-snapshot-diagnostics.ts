import { AsyncLocalStorage } from "node:async_hooks";
import { ExitCodeError } from "../../../platform/process/process-executor.js";

/** Фиксированные внутренние этапы без путей и низкоуровневых ошибок. */
export type HermesSourceSnapshotDiagnosticPhase =
  | "validate"
  | "reference-lock"
  | "publication-lock"
  | "source-git"
  | "snapshot-publish"
  | "native-projection";

interface DiagnosticContext {
  phase: HermesSourceSnapshotDiagnosticPhase;
  reported: boolean;
  readonly observer: (phase: HermesSourceSnapshotDiagnosticPhase) => void;
}

const diagnosticContext = new AsyncLocalStorage<DiagnosticContext>();

/** Создаёт внутренний test-only scope для наблюдения за фиксированной фазой ошибки snapshot. @internal
 * Observer не меняет результат материализации или тип/текст ошибки.
 */
export function withHermesSourceSnapshotFailureObserver<T>(
  observer: (phase: HermesSourceSnapshotDiagnosticPhase) => void,
  operation: () => Promise<T>,
): Promise<T> {
  return diagnosticContext.run({ phase: "validate", reported: false, observer }, operation);
}

/** Устанавливает одну разрешённую coarse phase для активного test observer. @internal */
export function markHermesSourceSnapshotDiagnosticPhase(phase: HermesSourceSnapshotDiagnosticPhase): void {
  const context = diagnosticContext.getStore();
  if (context) context.phase = phase;
}

/** Передаёт test observer только фиксированную фазу и игнорирует ошибки observer. @internal */
export function reportHermesSourceSnapshotFailurePhase(): void {
  const context = diagnosticContext.getStore();
  if (!context || context.reported) return;
  context.reported = true;
  try { context.observer(context.phase); } catch { /* Diagnostics must not affect fail-closed behavior. */ }
}

/** Преобразует результат вторичного Windows path verifier в фиксированный безопасный код. @internal */
export function sanitizeHermesPathIdentityDiagnostic(error: unknown): string {
  if (error instanceof ExitCodeError) {
    if (isVerifiedHelperLauncherRejection(error)) return "VERIFIED_HELPER_LAUNCHER_REJECTED";
    if (error.exitCode === 31) return "SECONDARY_PATH_ROOT_ACL_UNSAFE";
  }
  return "SECONDARY_PATH_IDENTITY_UNAVAILABLE";
}

function isVerifiedHelperLauncherRejection(error: ExitCodeError): boolean {
  if (error.exitCode !== 126) return false;
  const allowedPhases = new Set([
    "argument-decode", "argument-json", "argument-validation", "argument-type", "argument-nul",
    "path-normalization", "parent-directory-lock", "helper-file-lock", "integrity-check", "process-start",
  ]);
  const allowedExceptionTypes = new Set([
    "ArgumentException", "FileNotFoundException", "IOException", "InvalidOperationException",
    "PlatformNotSupportedException", "TypeInitializationException", "UnauthorizedAccessException",
  ]);
  return error.stderr.split(/\r?\n/u).some((line) => {
    const match = /^NATIVE_HELPER_GATE_FAIL:([a-z0-9-]+):([A-Za-z][A-Za-z0-9]*)$/u.exec(line);
    if (!match || !allowedExceptionTypes.has(match[2]!)) return false;
    const phase = match[1]!;
    return allowedPhases.has(phase) ||
      /^parent-directory-open-index-[0-9]+-win32-[0-9]+$/u.test(phase) ||
      /^parent-directory-check-win32-[0-9]+$/u.test(phase) ||
      /^helper-file-open-win32-[0-9]+$/u.test(phase);
  });
}
