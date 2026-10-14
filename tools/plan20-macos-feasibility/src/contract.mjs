export const EXPECTED_ATTESTATION = 'I confirm this preflight is running on a physical Apple Silicon Mac, not inside a VM/guest.';

/** Fail-closed guard: evidence belongs to HEAD only when every harness source file is committed and clean. */
export function validateHarnessStatus(status) {
  return typeof status === 'string' && status.length === 0 ? [] : ['HARNESS_NOT_EXACT_SHA'];
}

export const lifecycleScenarios = Object.freeze([
  'orchestrator-crash-restart-reattach',
  'controller-crash-restart-reattach',
  'detached-guest-child-stop',
  'controller-crash-live-unknown',
  'guest-agent-loss-unknown',
  'virtualization-api-unavailable-unknown',
  'mismatched-vm-or-nonce-unknown',
  'unsettled-stop-unknown',
  'timeout-unknown',
  'package-extract-controller-restart-cleanup',
]);

const HOST_FACT_PATTERNS = Object.freeze({
  model: /^Mac[A-Za-z0-9,.-]{1,40}$/,
  arm64Flag: /^(?:0|1)$/,
  macOSVersion: /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/,
  buildVersion: /^[A-Za-z0-9]{1,16}$/,
  architecture: /^(?:arm64|x86_64)$/,
});

/** Возвращает только короткие host identity поля по allowlist; stdout/stderr целиком не сохраняются. */
export function sanitizeHostFacts(input = {}) {
  return Object.fromEntries(Object.entries(HOST_FACT_PATTERNS).map(([key, pattern]) => {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    return [key, pattern.test(value) ? value : 'UNAVAILABLE'];
  }));
}

/** Проверяет структуру и обязательные gates, не принимая свободный текст как evidence. */
export function validateEvidence(evidence, expectedSha) {
  const errors = [];
  if (!evidence || evidence.schemaVersion !== 1) errors.push('SCHEMA_VERSION_INVALID');
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || evidence?.exactEbbSha !== expectedSha) errors.push('EVIDENCE_SHA_MISMATCH');
  if (!evidence?.host || typeof evidence.host !== 'object' || !evidence.host.facts) errors.push('HOST_EVIDENCE_MISSING');
  if (evidence?.guest !== null && (!evidence?.guest || typeof evidence.guest !== 'object')) errors.push('GUEST_EVIDENCE_INVALID');
  if (evidence?.host?.operatorPhysicalAppleSiliconAttestation !== false
    && evidence?.host?.operatorPhysicalAppleSiliconAttestation !== true) errors.push('INVALID_ATTESTATION_RECORD');
  if (evidence?.spikeController !== 'NOT_IMPLEMENTED') errors.push('SPIKE_CONTROLLER_STATUS_INVALID');
  const scenarios = evidence?.gates?.lifecycle;
  if (!scenarios || lifecycleScenarios.some(name => !Object.hasOwn(scenarios, name))) errors.push('INCOMPLETE_LIFECYCLE_MATRIX');
  if (evidence?.review?.architecture === undefined || evidence?.review?.security === undefined) errors.push('REVIEW_RECORDS_MISSING');
  if (evidence?.host && evidence?.guest && evidence.host === evidence.guest) errors.push('HOST_GUEST_NOT_DISTINCT');
  return [...new Set(errors)];
}

/** Формирует минимальный безопасный отчёт без локальных путей и свободного вывода команд. */
export function summarizeEvidence(evidence) {
  const gates = evidence?.gates ?? {};
  const lifecycle = gates.lifecycle ?? {};
  const allPassed = evidence?.spikeController === 'VERIFIED_CONTROLLER_WITH_REATTACH'
    && gates.preflight === 'PASS'
    && lifecycleScenarios.every(name => lifecycle[name] === 'PASS')
    && ['provider', 'packaging', 'cleanup'].every(name => gates[name] === 'PASS')
    && evidence?.review?.architecture === 'PASS'
    && evidence?.review?.security === 'PASS';
  const failedOrMissing = [];
  if (evidence?.spikeController !== 'VERIFIED_CONTROLLER_WITH_REATTACH') failedOrMissing.push('SPIKE_CONTROLLER_NOT_IMPLEMENTED');
  if (evidence?.spikeController !== 'VERIFIED_CONTROLLER_WITH_REATTACH') failedOrMissing.push('LIVE_VM_REATTACH_API_UNAVAILABLE');
  if (gates.preflight !== 'PASS') failedOrMissing.push(`PREFLIGHT_${safeStatus(gates.preflight)}`);
  for (const name of lifecycleScenarios) if (lifecycle[name] !== 'PASS') failedOrMissing.push(`LIFECYCLE_${name.toUpperCase().replaceAll('-', '_')}_${safeStatus(lifecycle[name])}`);
  for (const name of ['provider', 'packaging', 'cleanup']) if (gates[name] !== 'PASS') failedOrMissing.push(`${name.toUpperCase()}_${safeStatus(gates[name])}`);
  for (const name of ['architecture', 'security']) if (evidence?.review?.[name] !== 'PASS') failedOrMissing.push(`REVIEW_${name.toUpperCase()}_${safeStatus(evidence?.review?.[name])}`);
  return {
    schemaVersion: 1,
    exactEbbSha: evidence?.exactEbbSha ?? 'UNAVAILABLE',
    host: evidence?.host?.status ?? 'NOT_CAPTURED',
    hostIdentity: evidence?.host?.facts ?? null,
    physicalHostAttestation: evidence?.host?.operatorPhysicalAppleSiliconAttestation === true,
    guest: evidence?.guest?.status ?? 'NOT_CAPTURED',
    spikeController: evidence?.spikeController ?? 'NOT_CAPTURED',
    verdict: allPassed ? 'FEASIBLE' : 'NOT_VERIFIED',
    blockers: failedOrMissing,
    rawCommandOutputRetained: false,
    credentialsOrProviderResponseRetained: false,
  };
}

function safeStatus(value) {
  return typeof value === 'string' && /^[A-Z_]+$/.test(value) ? value : 'NOT_RUN';
}
