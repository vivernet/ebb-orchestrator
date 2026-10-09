import { AsyncLocalStorage } from "node:async_hooks";
import { ExitCodeError } from "../../../platform/process/process-executor.js";

/** Фиксированные внутренние этапы без путей и низкоуровневых ошибок. */
export const HERMES_SOURCE_SNAPSHOT_DIAGNOSTIC_PHASES = [
  "validate",
  "reference-lock",
  "publication-lock",
  "source-git",
  "snapshot-publish",
  "native-projection",
  "native-projection-helper-create",
  "native-projection-open-verify-temp",
  "native-projection-write-seal",
  "native-projection-owner-publish-link",
  "native-projection-alias-cleanup",
  "native-projection-final-verify",
] as const;

export type HermesSourceSnapshotDiagnosticPhase = typeof HERMES_SOURCE_SNAPSHOT_DIAGNOSTIC_PHASES[number];

const diagnosticPhases = new Set<string>(HERMES_SOURCE_SNAPSHOT_DIAGNOSTIC_PHASES);

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
  if (context && diagnosticPhases.has(phase)) context.phase = phase;
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
    if (error.stderr.includes("VERIFY_SAFE_PATH_REFUSED:")) {
      return standaloneSafePathRefusal(error) ?? "SECONDARY_PATH_IDENTITY_UNAVAILABLE";
    }
    if (error.exitCode === 31) return "SECONDARY_PATH_ROOT_ACL_UNSAFE";
    const componentAclFailure = error.stderr.split(/\r?\n/u)
      .map((line) => /^SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_([1-9][0-9]?):STAGE_([1-6])$/u.exec(line))
      .find((match) => match !== null);
    if (componentAclFailure && error.exitCode === 50 + Number(componentAclFailure[2]) &&
        Number(componentAclFailure[1]) <= 64) {
      return `SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_${componentAclFailure[1]}:STAGE_${componentAclFailure[2]}`;
    }
    const identityFailure = error.stderr.split(/\r?\n/u)
      .map((line) => /^SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:(ROOT|COMPONENT_INDEX_([1-9][0-9]?)|SERIALIZATION_LIMIT)$/u.exec(line))
      .find((match) => match !== null);
    if (identityFailure && error.exitCode === 34 &&
        (identityFailure[1] !== `COMPONENT_INDEX_${identityFailure[2]}` || Number(identityFailure[2]) <= 64)) {
      return `SECONDARY_PATH_IDENTITY_UNAVAILABLE:${identityFailure[1]}`;
    }
  }
  return "SECONDARY_PATH_IDENTITY_UNAVAILABLE";
}

/** Принимает только фиксированный stderr marker и exit code соответствующего native verifier. */
function standaloneSafePathRefusal(error: ExitCodeError): string | undefined {
  if (error.stdout !== "") return undefined;
  const stderr = error.stderr.replace(/\r?\n$/u, "");
  if (stderr.includes("\n") || stderr.includes("\r")) return undefined;
  const match = /^VERIFY_SAFE_PATH_REFUSED:(USER_IDENTITY|ROOT_OPEN|ROOT_IDENTITY|ROOT_ACL|OBJECT_IDENTITY|COMPONENT_OPEN:INDEX_(0|[1-9][0-9]*|64_PLUS)|COMPONENT_ACL:INDEX_(0|[1-9][0-9]*|64_PLUS):ACL_STAGE_([1-6]))$/u.exec(stderr);
  if (!match) return undefined;

  const refusal = match[1]!;
  if (refusal === "USER_IDENTITY") return error.exitCode === 10 ? "SECONDARY_PATH_USER_IDENTITY_UNAVAILABLE" : undefined;
  if (refusal === "ROOT_OPEN") return error.exitCode === 30 ? "SECONDARY_PATH_ROOT_OPEN_FAILED" : undefined;
  if (refusal === "ROOT_IDENTITY" || refusal === "ROOT_ACL") {
    if (error.exitCode !== 31) return undefined;
    return refusal === "ROOT_IDENTITY"
      ? "SECONDARY_PATH_IDENTITY_UNAVAILABLE:ROOT"
      : "SECONDARY_PATH_ROOT_ACL_UNSAFE";
  }
  if (refusal === "OBJECT_IDENTITY") {
    return error.exitCode === 34 ? "SECONDARY_PATH_IDENTITY_UNAVAILABLE" : undefined;
  }

  const componentIndex = match[2] ?? match[3];
  if (!componentIndex) return undefined;
  const index = componentIndex === "64_PLUS" ? undefined : Number(componentIndex);
  if (index !== undefined && index > 63) return undefined;
  if (refusal.startsWith("COMPONENT_OPEN:")) {
    if (index === undefined ? error.exitCode < 104 : error.exitCode !== 40 + index) return undefined;
    return `SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_${componentIndex}`;
  }

  const aclStage = Number(match[4]);
  if (error.exitCode !== 50 + aclStage) return undefined;
  return `SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_${componentIndex}:STAGE_${aclStage}`;
}

/** Проверяет динамический компонентный код ACL на точный allowlist без свободного текста. @internal */
export function isSafeHermesPathComponentAclDiagnostic(value: string, allowStandaloneOverflow = false): boolean {
  if (allowStandaloneOverflow) {
    const standaloneMatch = /^SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_(0|[1-9][0-9]*|64_PLUS):STAGE_([1-6])$/u.exec(value);
    if (standaloneMatch) {
      return standaloneMatch[1] === "64_PLUS" || Number(standaloneMatch[1]) <= 63;
    }
  }
  const match = /^SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_([1-9][0-9]?):STAGE_([1-6])$/u.exec(value);
  return match !== null && Number(match[1]) <= 64;
}

/** Проверяет только безопасный индекс component-open отказа standalone verifier. @internal */
export function isSafeHermesPathComponentOpenDiagnostic(value: string): boolean {
  const match = /^SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_(0|[1-9][0-9]*|64_PLUS)$/u.exec(value);
  return match !== null && (match[1] === "64_PLUS" || Number(match[1]) <= 63);
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
