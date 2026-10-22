import { randomBytes } from 'node:crypto';
import type { Database, DatabaseTx } from '../../platform/database/database.js';
import type { ProcessScopeSupervisor } from '../../platform/process/run-scope-supervisor.js';
import type { DarwinProcessGroupIdentityV1, ProcessScopeObservation } from '../../platform/process/process-inspector.js';
export type { DarwinProcessGroupIdentityV1 } from '../../platform/process/process-inspector.js';

const SAFE_WINDOWS_SCOPE_UNKNOWN_REASONS = new Set([
  'WINDOWS_ATTEMPT_NONCE_MISMATCH',
  'WINDOWS_ATTEMPT_JOB_STILL_LIVE',
  'WINDOWS_ATTEMPT_ABSENCE_EVIDENCE_MALFORMED',
  'WINDOWS_ATTEMPT_NEVER_LAUNCHED_CONFLICT',
  'WINDOWS_ATTEMPT_SESSION_PENDING',
  'WINDOWS_JOB_INSPECTION_UNAVAILABLE',
  'WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE',
  'WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE',
  'WINDOWS_JOB_INSPECTION_PROCESS_TIMEOUT',
  'WINDOWS_JOB_INSPECTION_HELPER_TIMEOUT',
  'WINDOWS_JOB_INSPECTION_HELPER_CLEANUP_UNPROVEN',
  'WINDOWS_JOB_INSPECTION_OUTPUT_LIMIT',
  'WINDOWS_JOB_INSPECTION_PROCESS_ABORTED',
  'WINDOWS_JOB_INSPECTION_PROCESS_EXIT_NONZERO',
  'WINDOWS_JOB_INSPECTION_PROCESS_SPAWN_FAILED',
  'WINDOWS_JOB_INSPECTION_HELPER_ARGUMENT_GATE_FAILED',
  'WINDOWS_JOB_INSPECTION_HELPER_PATH_GATE_FAILED',
  'WINDOWS_JOB_INSPECTION_HELPER_FILE_GATE_FAILED',
  'WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_GATE_FAILED',
  'WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_MISMATCH',
  'WINDOWS_JOB_INSPECTION_HELPER_PROCESS_START_GATE_FAILED',
  'WINDOWS_JOB_INSPECTION_NATIVE_LAUNCH_FAILED',
  'WINDOWS_JOB_INSPECTION_NATIVE_REFUSAL',
  'WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED',
  'WINDOWS_JOB_STOP_TIMEOUT',
  'WINDOWS_JOB_IDENTITY_MISMATCH',
  'WINDOWS_JOB_IDENTITY_UNPROVEN',
  'WINDOWS_PHASE_UNAVAILABLE',
  'WINDOWS_JOB_OPEN_UNAVAILABLE',
  'WINDOWS_JOB_ABSENT_LAUNCH_PENDING',
  'WINDOWS_JOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY',
  'WINDOWS_JOB_ABSENT_OWNER_STATE_UNKNOWN',
  'WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING',
  'WINDOWS_JOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE',
  'WINDOWS_JOB_ABSENT_HELPER_STILL_LIVE',
  'WINDOWS_MAPPING_OR_IDENTITY_UNAVAILABLE',
  'WINDOWS_JOB_ACCOUNTING_UNAVAILABLE',
]);

export type RunContainmentKind = 'windows-job' | 'systemd-user-service' | 'darwin-process-group';
export type RunProcessOwnerState = 'PREPARED' | 'LAUNCHING' | 'LIVE' | 'STOPPING' | 'STOPPED' | 'UNKNOWN';

/**
 * Выбирает durable containment kind по Node platform без host probes и побочных эффектов.
 * @param platform Платформа, сообщённая вызывающей стороной.
 * @returns Поддерживаемый kind либо `null`, если платформа не входит в контракт.
 */
export function containmentKindForPlatform(platform: NodeJS.Platform): RunContainmentKind | null {
  if (platform === 'win32') return 'windows-job';
  if (platform === 'linux') return 'systemd-user-service';
  if (platform === 'darwin') return 'darwin-process-group';
  return null;
}

/**
 * Кодирует проверенный Darwin boot/start/process-group tuple для существующего owner string field.
 * Формат не подтверждает живость процесса или пустоту группы.
 * @param identity Нормализуемая identity версии 1.
 * @returns JSON со стабильным порядком ключей и UUID в нижнем регистре.
 * @throws {TypeError} Если tuple отсутствует или нарушает формат.
 */
export function encodeDarwinProcessGroupIdentityV1(identity: DarwinProcessGroupIdentityV1): string {
  if (!isDarwinProcessGroupIdentityV1(identity)) throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE');
  return JSON.stringify({
    formatVersion: 1,
    bootSessionUUID: identity.bootSessionUUID.toLowerCase(),
    pid: identity.pid,
    startTvsec: identity.startTvsec,
    startUsec: identity.startUsec,
    pgid: identity.pgid,
    sid: identity.sid,
  });
}

/**
 * Разбирает только точную versioned Darwin identity projection; отсутствующее evidence закрывается отказом.
 * @param value Сохранённая сериализация identity.
 * @returns Проверенный tuple версии 1 с нормализованным UUID.
 * @throws {TypeError} Если OS evidence отсутствует, превышает лимит или malformed.
 */
export function parseDarwinProcessGroupIdentityV1(value: unknown): DarwinProcessGroupIdentityV1 {
  if (typeof value !== 'string' || value.length > 512) throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE'); }
  if (!isDarwinProcessGroupIdentityV1(parsed)) throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE');
  const normalized: DarwinProcessGroupIdentityV1 = {
    formatVersion: 1,
    bootSessionUUID: parsed.bootSessionUUID.toLowerCase(),
    pid: parsed.pid,
    startTvsec: parsed.startTvsec,
    startUsec: parsed.startUsec,
    pgid: parsed.pgid,
    sid: parsed.sid,
  };
  if (value !== JSON.stringify(normalized)) throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE');
  return normalized;
}

function isDarwinProcessGroupIdentityV1(value: unknown): value is DarwinProcessGroupIdentityV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity).sort();
  return keys.join(',') === 'bootSessionUUID,formatVersion,pgid,pid,sid,startTvsec,startUsec' &&
    identity.formatVersion === 1 && typeof identity.bootSessionUUID === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.bootSessionUUID) &&
    Number.isSafeInteger(identity.pid) && (identity.pid as number) > 0 &&
    Number.isSafeInteger(identity.startTvsec) && (identity.startTvsec as number) >= 0 &&
    Number.isSafeInteger(identity.startUsec) && (identity.startUsec as number) >= 0 && (identity.startUsec as number) < 1_000_000 &&
    Number.isSafeInteger(identity.pgid) && (identity.pgid as number) > 0 &&
    Number.isSafeInteger(identity.sid) && (identity.sid as number) > 0;
}

/**
 * Durable Run-owned identity prepared before asking an OS supervisor to launch Hermes.
 * OS observations remain null until the authoritative Job Object/systemd service reports them.
 */
export interface RunProcessOwner {
  runId: string;
  sourceTag: string;
  hermesHome: string;
  /** Точная canonical JCS identity snapshot; NULL у исторических owners, без backfill. */
  hermesSourceSnapshotKey?: string | null;
  containmentKind: RunContainmentKind;
  containmentId: string;
  launchNonce: string;
  systemdInvocationId: string | null;
  systemdControlGroup: string | null;
  supervisorPid: number | null;
  supervisorStartIdentity: string | null;
  pid: number | null;
  platform: string | null;
  processStartIdentity: string | null;
  executableIdentity: string | null;
  state: RunProcessOwnerState;
  stopEvidence: string | null;
  updatedAt: string;
}

/**
 * Создаёт идентичность Run для последующего OS containment до любого вызова launch.
 * Source tag детерминирован по Run, а containment ID и nonce независимы и случайны;
 * PID, unit/job runtime identity и process evidence остаются неизвестными до readback ОС.
 *
 * @param runId Уникальный ID нового Run от Orchestrator.
 * @param hermesHome Стабильный Orchestrator-owned профиль Hermes именно для этого Run.
 * @param containmentKind Поддерживаемый нативный вид OS-владельца процесса.
 * @param hermesSourceSnapshotKey Проверенный canonical source key; отсутствие допустимо для legacy mapping.
 * @returns PREPARED owner row, готовая к атомарной записи вместе с Run.
 * @throws {TypeError} Если вход не задаёт Run, profile home или поддерживаемую платформу.
 */
export function prepareRunProcessOwner(
  runId: string,
  hermesHome: string,
  containmentKind: RunContainmentKind,
  hermesSourceSnapshotKey?: string | null,
): RunProcessOwner {
  assertNonEmpty(runId, 'runId');
  assertNonEmpty(hermesHome, 'hermesHome');
  if (containmentKind !== 'windows-job' && containmentKind !== 'systemd-user-service' && containmentKind !== 'darwin-process-group') {
    throw new TypeError('Run process containment kind is unsupported.');
  }
  assertSourceSnapshotKey(hermesSourceSnapshotKey, containmentKind);

  return {
    runId,
    sourceTag: `ebb-run:${runId}`,
    hermesHome,
    hermesSourceSnapshotKey: hermesSourceSnapshotKey ?? null,
    containmentKind,
    containmentId: randomBytes(32).toString('hex'),
    launchNonce: randomBytes(32).toString('hex'),
    systemdInvocationId: null,
    systemdControlGroup: null,
    supervisorPid: null,
    supervisorStartIdentity: null,
    pid: null,
    platform: null,
    processStartIdentity: null,
    executableIdentity: null,
    state: 'PREPARED',
    stopEvidence: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Вставляет предварительно подготовленного owner в transaction создания Run.
 * До подтверждённого OS launch все поля наблюдаемой идентичности обязаны оставаться null.
 *
 * @param tx Активная SQLite transaction вызывающего RunService.
 * @param owner Подготовленная process-owner запись для того же Run.
 * @throws {TypeError} Если изменены детерминированный tag, стартовый state или OS observations.
 * @throws {TypeError} Если source key не совпадает с canonical versioned identity.
 * @throws {Error} Если foreign key/unique constraints отклоняют запись.
 */
export function insertRunProcessOwnerTx(tx: DatabaseTx, owner: RunProcessOwner): void {
  assertPreparedOwner(owner);
  insertPreparedRunProcessGenerationTx(tx, owner, 1, null, 'UNBOUND');
  tx.run(
    `INSERT INTO run_process_owners(
      run_id, source_tag, hermes_home, hermes_source_snapshot_key, containment_kind, containment_id, launch_nonce,
      systemd_invocation_id, systemd_control_group, supervisor_pid, supervisor_start_identity, pid, platform,
      process_start_identity, executable_identity, state, stop_evidence, updated_at
    ) VALUES (
      $runId, $sourceTag, $hermesHome, $hermesSourceSnapshotKey, $containmentKind, $containmentId, $launchNonce,
      $systemdInvocationId, $systemdControlGroup, $supervisorPid, $supervisorStartIdentity, $pid, $platform,
      $processStartIdentity, $executableIdentity, $state, $stopEvidence, $updatedAt
    )`,
    {
      runId: owner.runId,
      sourceTag: owner.sourceTag,
      hermesHome: owner.hermesHome,
      hermesSourceSnapshotKey: owner.hermesSourceSnapshotKey ?? null,
      containmentKind: owner.containmentKind,
      containmentId: owner.containmentId,
      launchNonce: owner.launchNonce,
      systemdInvocationId: owner.systemdInvocationId,
      systemdControlGroup: owner.systemdControlGroup,
      supervisorPid: owner.supervisorPid,
      supervisorStartIdentity: owner.supervisorStartIdentity,
      pid: owner.pid,
      platform: owner.platform,
      processStartIdentity: owner.processStartIdentity,
      executableIdentity: owner.executableIdentity,
      state: owner.state,
      stopEvidence: owner.stopEvidence,
      updatedAt: owner.updatedAt,
    },
  );
}

export interface RunProcessOwnerIdentity {
  systemdInvocationId?: string | null;
  systemdControlGroup?: string | null;
  supervisorPid?: number | null;
  supervisorStartIdentity?: string | null;
  pid?: number | null;
  platform?: string | null;
  processStartIdentity?: string | null;
  executableIdentity?: string | null;
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunProcessOwnerState, ReadonlySet<RunProcessOwnerState>>> = {
  PREPARED: new Set(['LAUNCHING', 'STOPPED']),
  LAUNCHING: new Set(['LIVE', 'STOPPED', 'UNKNOWN']),
  LIVE: new Set(['STOPPING', 'STOPPED', 'UNKNOWN']),
  STOPPING: new Set(['STOPPED', 'UNKNOWN']),
  STOPPED: new Set(),
  UNKNOWN: new Set(['LIVE', 'STOPPING', 'STOPPED', 'UNKNOWN']),
};

/**
 * Выполняет compare-and-set переход единственного durable OS owner.
 * Идентичность ОС записывается только из подтверждённого supervisor readback;
 * terminal `STOPPED` требует явного безопасного evidence code, а не PID/exit claim.
 * Source snapshot key неизменен: переходы обновляют только наблюдаемую OS identity и state.
 *
 * @param tx Транзакция владельца Run.
 * @param input Run, ожидаемое/целевое состояние и подтверждённая OS identity.
 * @param input.runId ID Run с durable owner.
 * @param input.expectedState Текущее состояние для compare-and-set.
 * @param input.nextState Разрешённое следующее состояние.
 * @param input.identity OS identity только из подтверждённого supervisor readback.
 * @param input.evidence Обязательное bounded evidence для STOPPED/UNKNOWN.
 * @throws {Error} Если строки нет, состояние изменилось конкурентно либо переход запрещён.
 * @throws {TypeError} Если identity или evidence не удовлетворяют state contract.
 */
export function transitionRunProcessOwnerTx(
  tx: DatabaseTx,
  input: {
    runId: string;
    expectedState: RunProcessOwnerState;
    nextState: RunProcessOwnerState;
    identity?: RunProcessOwnerIdentity;
    evidence?: string;
  },
): void {
  if (input.evidence === 'LAUNCH_NOT_DISPATCHED') {
    throw new TypeError('LAUNCH_NOT_DISPATCHED can only be persisted by the Hermes launch adapter.');
  }
  assertCurrentRunProcessGenerationTx(tx, input.runId);
  const current = tx.get<{ state: string; containment_kind: string }>(
    'SELECT state,containment_kind FROM run_process_owners WHERE run_id=$runId', { runId: input.runId },
  );
  if (!current) throw new Error('RUN_PROCESS_OWNER_MISSING');
  if (current.state !== input.expectedState) throw new Error('RUN_PROCESS_OWNER_STATE_CHANGED');
  if (!ALLOWED_TRANSITIONS[input.expectedState]?.has(input.nextState)) {
    throw new Error('RUN_PROCESS_OWNER_TRANSITION_INVALID');
  }
  if (input.nextState === 'STOPPED' || input.nextState === 'UNKNOWN') {
    if (input.nextState === 'STOPPED') {
      assertStoppedEvidence(input.evidence, current.containment_kind, input.expectedState);
    }
    else assertEvidence(input.evidence);
  } else if (input.evidence !== undefined) {
    throw new TypeError('Stop evidence is only valid for STOPPED or UNKNOWN transitions.');
  }

  const identity = input.identity ?? {};
  if (input.nextState === 'LIVE') assertLiveIdentity(identity);
  if (input.nextState === 'LAUNCHING' && Object.keys(identity).length !== 0) {
    throw new TypeError('A LAUNCHING transition cannot invent an observed process identity.');
  }
  const now = new Date().toISOString();
  tx.run(
    `UPDATE run_process_owners SET
      systemd_invocation_id=COALESCE($systemdInvocationId,systemd_invocation_id),
      systemd_control_group=COALESCE($systemdControlGroup,systemd_control_group),
      supervisor_pid=COALESCE($supervisorPid,supervisor_pid),
      supervisor_start_identity=COALESCE($supervisorStartIdentity,supervisor_start_identity),
      pid=COALESCE($pid,pid), platform=COALESCE($platform,platform),
      process_start_identity=COALESCE($processStartIdentity,process_start_identity),
      executable_identity=COALESCE($executableIdentity,executable_identity),
      state=$nextState, stop_evidence=$evidence, updated_at=$updatedAt
     WHERE run_id=$runId AND state=$expectedState`,
    {
      runId: input.runId,
      expectedState: input.expectedState,
      nextState: input.nextState,
      systemdInvocationId: identity.systemdInvocationId ?? null,
      systemdControlGroup: identity.systemdControlGroup ?? null,
      supervisorPid: identity.supervisorPid ?? null,
      supervisorStartIdentity: identity.supervisorStartIdentity ?? null,
      pid: identity.pid ?? null,
      platform: identity.platform ?? null,
      processStartIdentity: identity.processStartIdentity ?? null,
      executableIdentity: identity.executableIdentity ?? null,
      evidence: input.evidence ?? null,
      updatedAt: now,
    },
  );
  if ((tx.get<{ changes: number }>('SELECT changes() AS changes')?.changes ?? 0) !== 1) {
    throw new Error('RUN_PROCESS_OWNER_STATE_CHANGED');
  }
  syncCurrentRunProcessGenerationTx(tx, input.runId);
}

/** Синхронизирует только текущее незавершённое поколение после owner/capture CAS; STOPPED history неизменна. */
export function syncCurrentRunProcessGenerationTx(tx: DatabaseTx, runId: string): void {
  const history = tx.get<{ state: string }>(`SELECT g.state FROM run_process_owner_generations g
    JOIN run_process_owners o ON o.run_id=g.run_id AND o.current_generation=g.generation WHERE o.run_id=$runId`, { runId });
  if (!history) throw new Error('RUN_PROCESS_GENERATION_MISSING');
  if (history.state === 'STOPPED') return;
  tx.run(`UPDATE run_process_owner_generations SET
    (source_tag,hermes_home,hermes_source_snapshot_key,capture_state,containment_kind,containment_id,launch_nonce,
     systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
     process_start_identity,executable_identity,state,stop_evidence,updated_at) =
    (SELECT source_tag,hermes_home,hermes_source_snapshot_key,capture_state,containment_kind,containment_id,launch_nonce,
     systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
     process_start_identity,executable_identity,state,stop_evidence,updated_at FROM run_process_owners WHERE run_id=$runId)
    WHERE run_id=$runId AND generation=(SELECT current_generation FROM run_process_owners WHERE run_id=$runId)
      AND state <> 'STOPPED'`, { runId });
  if ((tx.get<{ changes: number }>('SELECT changes() AS changes')?.changes ?? 0) !== 1) {
    throw new Error('RUN_PROCESS_GENERATION_CHANGED');
  }
}

function insertPreparedRunProcessGenerationTx(
  tx: DatabaseTx, owner: RunProcessOwner, generation: number, attempt: number | null, captureState: 'UNBOUND' | 'BOUND',
): void {
  tx.run(`INSERT INTO run_process_owner_generations(
    run_id,generation,run_attempt,source_tag,hermes_home,hermes_source_snapshot_key,capture_state,
    containment_kind,containment_id,launch_nonce,systemd_invocation_id,systemd_control_group,
    supervisor_pid,supervisor_start_identity,pid,platform,process_start_identity,executable_identity,state,stop_evidence,updated_at)
    VALUES($runId,$generation,$attempt,$sourceTag,$hermesHome,$sourceKey,$captureState,
      $containmentKind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$updatedAt)`, {
    runId: owner.runId, generation, attempt, sourceTag: owner.sourceTag, hermesHome: owner.hermesHome,
    sourceKey: owner.hermesSourceSnapshotKey ?? null, captureState, containmentKind: owner.containmentKind,
    containmentId: owner.containmentId, launchNonce: owner.launchNonce, updatedAt: owner.updatedAt,
  });
  if ((tx.get<{ changes: number }>('SELECT changes() AS changes')?.changes ?? 0) !== 1) throw new Error('RUN_PROCESS_OWNER_MISSING');
}

/**
 * В caller transaction создаёт PREPARED поколение того же Run после точного STOPPED proof.
 * Сохраняет прежнюю историю, shared Hermes home и BOUND capture; IDs/nonce всегда новые.
 * Caller в этой же transaction обязан claim-ить исходную Scheduler reservation и обновить Run attempt.
 */
export function rotateRunProcessOwnerForResumeTx(tx: DatabaseTx, input: {
  runId: string; attempt: number; previousAttempt: number | null;
}): number {
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= (input.previousAttempt ?? 0)) {
    throw new Error('RUN_PROCESS_GENERATION_ATTEMPT_INVALID');
  }
  const owner = getRunProcessOwner(tx, input.runId);
  if (!owner) throw new Error('RUN_PROCESS_OWNER_MISSING');
  const current = tx.get<{ current_generation: number; capture_state: string; state: string;
    containment_kind: string; containment_id: string; launch_nonce: string; stop_evidence: string | null;
    run_attempt: number | null }>(`SELECT o.*,r.attempt AS run_attempt FROM run_process_owners o
      JOIN agent_runs r ON r.id=o.run_id WHERE o.run_id=$runId`, { runId: input.runId });
  if (!current || current.capture_state !== 'BOUND' || current.state !== 'STOPPED' ||
      current.run_attempt !== input.previousAttempt ||
      !isAuthoritativeRunProcessStopEvidence(current.stop_evidence, current.containment_kind)) {
    throw new Error('RUN_PROCESS_GENERATION_STOP_UNPROVEN');
  }
  const history = tx.get<{ state: string; containment_id: string; launch_nonce: string; stop_evidence: string | null }>(
    'SELECT state,containment_id,launch_nonce,stop_evidence FROM run_process_owner_generations WHERE run_id=$runId AND generation=$generation',
    { runId: input.runId, generation: current.current_generation });
  if (!history || history.state !== 'STOPPED' || history.containment_id !== current.containment_id ||
      history.launch_nonce !== current.launch_nonce || history.stop_evidence !== current.stop_evidence) {
    throw new Error('RUN_PROCESS_GENERATION_STOP_UNPROVEN');
  }
  const generation = current.current_generation + 1;
  const nextOwner = prepareRunProcessOwner(input.runId, owner.hermesHome, owner.containmentKind, owner.hermesSourceSnapshotKey);
  insertPreparedRunProcessGenerationTx(tx, nextOwner, generation, input.attempt, 'BOUND');
  tx.run(`UPDATE run_process_owners SET current_generation=$generation,
    containment_id=$containmentId,launch_nonce=$launchNonce,state='PREPARED',stop_evidence=NULL,
    systemd_invocation_id=NULL,systemd_control_group=NULL,supervisor_pid=NULL,supervisor_start_identity=NULL,
    pid=NULL,platform=NULL,process_start_identity=NULL,executable_identity=NULL,updated_at=$updatedAt
    WHERE run_id=$runId AND current_generation=$previousGeneration AND state='STOPPED' AND capture_state='BOUND'
      AND containment_id=$previousContainment AND launch_nonce=$previousNonce`, {
      runId: input.runId, generation, previousGeneration: current.current_generation,
      containmentId: nextOwner.containmentId, launchNonce: nextOwner.launchNonce,
      previousContainment: current.containment_id, previousNonce: current.launch_nonce, updatedAt: nextOwner.updatedAt,
    });
  if ((tx.get<{ changes: number }>('SELECT changes() AS changes')?.changes ?? 0) !== 1) throw new Error('RUN_PROCESS_GENERATION_CHANGED');
  return generation;
}

function assertLiveIdentity(identity: RunProcessOwnerIdentity): void {
  if (identity.platform === 'linux') {
    assertNonEmpty(identity.systemdInvocationId ?? '', 'systemdInvocationId');
    assertNonEmpty(identity.systemdControlGroup ?? '', 'systemdControlGroup');
    if (!identity.systemdControlGroup!.startsWith('/')) throw new TypeError('systemdControlGroup must be an absolute cgroup path.');
    assertPositivePid(identity.pid, 'pid');
  } else if (identity.platform === 'win32') {
    assertPositivePid(identity.supervisorPid, 'supervisorPid');
    assertNonEmpty(identity.supervisorStartIdentity ?? '', 'supervisorStartIdentity');
    assertPositivePid(identity.pid, 'pid');
    assertNonEmpty(identity.processStartIdentity ?? '', 'processStartIdentity');
    assertNonEmpty(identity.executableIdentity ?? '', 'executableIdentity');
  } else if (identity.platform === 'darwin') {
    const anchor = parseDarwinProcessGroupIdentityV1(identity.supervisorStartIdentity);
    const runner = parseDarwinProcessGroupIdentityV1(identity.processStartIdentity);
    if (identity.systemdInvocationId != null || identity.systemdControlGroup != null ||
        identity.supervisorPid !== anchor.pid || identity.pid !== runner.pid ||
        anchor.bootSessionUUID !== runner.bootSessionUUID || anchor.pgid !== anchor.pid ||
        runner.pgid !== anchor.pgid || runner.sid !== anchor.sid) {
      throw new TypeError('DARWIN_PROCESS_IDENTITY_UNAVAILABLE');
    }
    assertNonEmpty(identity.executableIdentity ?? '', 'executableIdentity');
  } else {
    throw new TypeError('A LIVE Run owner requires a supported native platform identity.');
  }
}

function assertPositivePid(value: number | null | undefined, field: string): void {
  if (!Number.isSafeInteger(value) || value! <= 0) throw new TypeError(`${field} must be a positive process ID.`);
}

function assertEvidence(value: string | undefined): asserts value is string {
  if (!value || !/^[A-Z0-9_:-]{1,96}$/.test(value)) {
    throw new TypeError('Process-owner transition requires a bounded safe evidence code.');
  }
}

function assertStoppedEvidence(
  value: string | undefined,
  containmentKind: string,
  expectedState: RunProcessOwnerState,
): asserts value is string {
  if (!isAuthoritativeRunProcessStopEvidence(value, containmentKind)) {
    throw new TypeError('Process-owner STOPPED transition requires authoritative OS evidence.');
  }
  if ((value === 'NEVER_LAUNCHED' && expectedState !== 'PREPARED') ||
      value === 'LAUNCH_NOT_DISPATCHED') {
    throw new TypeError('Process-owner STOPPED evidence does not match the owner state being stopped.');
  }
}

/** Проверяет синтаксис bounded evidence token; это само по себе не доказывает STOPPED. */
export function isCanonicalRunProcessStopEvidence(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9_:-]{1,96}$/.test(value);
}

/** Проверяет, что durable evidence пришло из одного из production STOPPED readback путей. */
export function isAuthoritativeRunProcessStopEvidence(value: unknown, containmentKind: unknown): value is string {
  if (!isCanonicalRunProcessStopEvidence(value) ||
      (containmentKind !== 'windows-job' && containmentKind !== 'systemd-user-service' && containmentKind !== 'darwin-process-group')) return false;
  if (value === 'NEVER_LAUNCHED' || value === 'LAUNCH_NOT_DISPATCHED') return true;
  if (containmentKind === 'windows-job') {
    return value === 'WINDOWS_JOB_EMPTY' || value === 'WINDOWS_JOB_AND_HELPER_ABSENT';
  }
  if (containmentKind === 'systemd-user-service') {
    return value === 'SYSTEMD_CGROUP_EMPTY' || value === 'UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT';
  }
  if (containmentKind === 'darwin-process-group') {
    return value === 'DARWIN_GROUP_EMPTY' || value === 'BOOT_SESSION_CHANGED';
  }
  return false;
}

/** Возвращает durable owner, проверяя SQLite values; historical source key остаётся NULL. */
export function getRunProcessOwner(database: Database | DatabaseTx, runId: string): RunProcessOwner | undefined {
  const row = database.get<Record<string, unknown>>(
    "SELECT * FROM run_process_owners WHERE run_id=$runId", { runId },
  );
  if (!row) return undefined;
  const owner = parseOwnerRow(row);
  assertCurrentRunProcessGenerationTx(database, runId);
  return owner;
}

/** Проверяет current pointer и exact OS/source projection; поздняя INVALID capture не переписывает STOPPED history. */
function assertCurrentRunProcessGenerationTx(tx: DatabaseTx, runId: string): void {
  const matching = tx.get<{ run_id: string }>(`SELECT o.run_id FROM run_process_owners o
    JOIN run_process_owner_generations g ON g.run_id=o.run_id AND g.generation=o.current_generation
    WHERE o.run_id=$runId AND g.source_tag=o.source_tag AND g.hermes_home=o.hermes_home
      AND g.hermes_source_snapshot_key IS o.hermes_source_snapshot_key
      AND (g.capture_state=o.capture_state OR (g.state='STOPPED' AND o.capture_state='INVALID'))
      AND g.containment_kind=o.containment_kind AND g.containment_id=o.containment_id AND g.launch_nonce=o.launch_nonce
      AND g.state=o.state AND g.stop_evidence IS o.stop_evidence
      AND (g.updated_at=o.updated_at OR (g.state='STOPPED' AND o.capture_state='INVALID'))
      AND g.systemd_invocation_id IS o.systemd_invocation_id AND g.systemd_control_group IS o.systemd_control_group
      AND g.supervisor_pid IS o.supervisor_pid AND g.supervisor_start_identity IS o.supervisor_start_identity
      AND g.pid IS o.pid AND g.platform IS o.platform AND g.process_start_identity IS o.process_start_identity
      AND g.executable_identity IS o.executable_identity`, { runId });
  if (!matching) throw new Error('RUN_PROCESS_GENERATION_MISMATCH');
}

/**
 * Останавливает или доказывает пустоту каждого nonterminal Run scope до последующих startup callbacks.
 * PREPARED доказывает отсутствие launch dispatch; любой неизвестный OS readback сохраняется UNKNOWN
 * и выбрасывается, чтобы SystemLifecycle оставил систему DEGRADED до восстановления.
 *
 * @param database Уже migrated SQLite с Run и owner rows.
 * @param supervisor Платформенный authoritative Job/cgroup manager.
 * @throws {Error} При неизвестном scope, timeout, malformed owner или ошибке durable transition.
 */
export async function preflightRunProcessOwners(
  database: Database,
  supervisor: ProcessScopeSupervisor,
): Promise<void> {
  const rows = database.all<Record<string, unknown>>(
    `SELECT run.id AS active_run_id, owner.run_id AS owner_run_id, owner.*
       FROM agent_runs run
       LEFT JOIN run_process_owners owner ON owner.run_id=run.id
      WHERE run.status IN ('STARTED','IN_PROGRESS','COMPLETING')
         OR (run.status IN ('COMPLETED','FAILED','CANCELLED') AND owner.run_id IS NOT NULL)
      ORDER BY run.id`,
  );
  const ownerlessRun = rows.find((row) => row.owner_run_id === null || row.owner_run_id === undefined);
  if (ownerlessRun) {
    const runId = ownerlessRun.active_run_id;
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('RUN_PROCESS_OWNER_INVALID');
    throw new Error(`RUN_PROCESS_OWNER_MISSING:${runId}`);
  }
  const owners = rows.map(parseOwnerRow);
  const stoppedWithoutProof = owners.find((owner) =>
    owner.state === 'STOPPED' && (owner.stopEvidence === null || owner.stopEvidence.trim() === ''),
  );
  if (stoppedWithoutProof) throw new Error(`RUN_PROCESS_STOP_PROOF_MISSING:${stoppedWithoutProof.runId}`);
  const stoppedWithInvalidProof = owners.find((owner) =>
    owner.state === 'STOPPED' && !isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind),
  );
  if (stoppedWithInvalidProof) throw new Error(`RUN_PROCESS_STOP_PROOF_INVALID:${stoppedWithInvalidProof.runId}`);

  // Validate the whole inventory before any supervisor/recovery side effect.
  for (const owner of owners) assertCurrentRunProcessGenerationTx(database, owner.runId);

  for (const owner of owners) {
    if (owner.state === 'STOPPED') continue;
    if (owner.state === 'PREPARED') {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: owner.runId, expectedState: 'PREPARED', nextState: 'STOPPED', evidence: 'NEVER_LAUNCHED',
      }));
      continue;
    }

    const observation = await supervisor.inspect(owner);
    if (observation.state === 'STOPPED') {
      markOwnerStopped(database, owner, observation.evidence);
      continue;
    }
    if (observation.state === 'UNKNOWN') {
      markOwnerUnknown(database, owner);
      const safeReason = owner.containmentKind === 'windows-job' && SAFE_WINDOWS_SCOPE_UNKNOWN_REASONS.has(observation.reason)
        ? new Error(observation.reason)
        : undefined;
      throw new Error(`RUN_PROCESS_SCOPE_UNKNOWN:${owner.runId}`, safeReason ? { cause: safeReason } : undefined);
    }

    let liveIdentity = observation.identity;
    if (owner.state === 'LAUNCHING' || owner.state === 'UNKNOWN') {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: owner.runId,
        expectedState: owner.state,
        nextState: 'LIVE',
        identity: observationToOwnerIdentity(observation),
      }));
      liveIdentity = { ...observation.identity, state: 'LIVE' };
    }
    if (owner.state !== 'STOPPING') {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: owner.runId, expectedState: liveIdentity.state, nextState: 'STOPPING',
      }));
      liveIdentity = { ...liveIdentity, state: 'STOPPING' };
    }
    const stop = await supervisor.stop(liveIdentity);
    const final = stop.state === 'STOPPED' ? stop : await supervisor.waitForStopped(liveIdentity, 30_000);
    if (final.state !== 'STOPPED') {
      markOwnerUnknown(database, { ...owner, state: 'STOPPING' });
      throw new Error(`RUN_PROCESS_SCOPE_STOP_UNPROVEN:${owner.runId}`);
    }
    markOwnerStopped(database, { ...owner, state: 'STOPPING' }, final.evidence);
  }
}

function observationToOwnerIdentity(observation: Extract<ProcessScopeObservation, { state: 'LIVE' }>): RunProcessOwnerIdentity {
  const { identity } = observation;
  return {
    systemdInvocationId: identity.systemdInvocationId,
    systemdControlGroup: identity.systemdControlGroup,
    supervisorPid: identity.supervisorPid,
    supervisorStartIdentity: identity.supervisorStartIdentity,
    pid: identity.pid,
    platform: identity.platform,
    processStartIdentity: identity.processStartIdentity,
    executableIdentity: identity.executableIdentity,
  };
}

function markOwnerStopped(database: Database, owner: RunProcessOwner, evidence: string): void {
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId: owner.runId, expectedState: owner.state, nextState: 'STOPPED', evidence,
  }));
}

function markOwnerUnknown(database: Database, owner: RunProcessOwner): void {
  if (owner.state === 'STOPPED' || owner.state === 'PREPARED') return;
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId: owner.runId, expectedState: owner.state, nextState: 'UNKNOWN', evidence: 'OS_STATE_UNPROVEN',
  }));
}

function parseOwnerRow(row: Record<string, unknown>): RunProcessOwner {
  const required = (key: string): string => {
    const value = row[key];
    if (typeof value !== 'string' || value.trim() === '') throw new Error('RUN_PROCESS_OWNER_INVALID');
    return value;
  };
  const optionalString = (key: string): string | null => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new Error('RUN_PROCESS_OWNER_INVALID');
    return value;
  };
  const optionalNumber = (key: string): number | null => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('RUN_PROCESS_OWNER_INVALID');
    return value;
  };
  const kind = required('containment_kind');
  const state = required('state');
  if (kind !== 'windows-job' && kind !== 'systemd-user-service' && kind !== 'darwin-process-group') throw new Error('RUN_PROCESS_OWNER_INVALID');
  if (!['PREPARED', 'LAUNCHING', 'LIVE', 'STOPPING', 'STOPPED', 'UNKNOWN'].includes(state)) throw new Error('RUN_PROCESS_OWNER_INVALID');
  const owner: RunProcessOwner = {
    runId: required('run_id'),
    sourceTag: required('source_tag'),
    hermesHome: required('hermes_home'),
    hermesSourceSnapshotKey: optionalString('hermes_source_snapshot_key'),
    containmentKind: kind,
    containmentId: required('containment_id'),
    launchNonce: required('launch_nonce'),
    systemdInvocationId: optionalString('systemd_invocation_id'),
    systemdControlGroup: optionalString('systemd_control_group'),
    supervisorPid: optionalNumber('supervisor_pid'),
    supervisorStartIdentity: optionalString('supervisor_start_identity'),
    pid: optionalNumber('pid'),
    platform: optionalString('platform'),
    processStartIdentity: optionalString('process_start_identity'),
    executableIdentity: optionalString('executable_identity'),
    state: state as RunProcessOwnerState,
    stopEvidence: optionalString('stop_evidence'),
    updatedAt: required('updated_at'),
  };
  if (owner.sourceTag !== `ebb-run:${owner.runId}` || !/^[a-f0-9]{64}$/.test(owner.containmentId) || !/^[a-f0-9]{64}$/.test(owner.launchNonce)) {
    throw new Error('RUN_PROCESS_OWNER_INVALID');
  }
  if (owner.hermesSourceSnapshotKey !== null &&
      !isCanonicalSourceSnapshotKey(owner.hermesSourceSnapshotKey, kind === 'windows-job' ? 'win32' : 'linux', true)) {
    throw new Error('RUN_PROCESS_OWNER_INVALID');
  }
  return owner;
}

function assertPreparedOwner(owner: RunProcessOwner): void {
  assertNonEmpty(owner.runId, 'runId');
  if (owner.sourceTag !== `ebb-run:${owner.runId}`) throw new TypeError('Run process source tag must be deterministic.');
  assertNonEmpty(owner.hermesHome, 'hermesHome');
  assertSourceSnapshotKey(owner.hermesSourceSnapshotKey, owner.containmentKind);
  if (!/^[a-f0-9]{64}$/.test(owner.containmentId)) throw new TypeError('Containment ID must be a random 256-bit lowercase hex value.');
  if (!/^[a-f0-9]{64}$/.test(owner.launchNonce)) throw new TypeError('Launch nonce must be a random 256-bit lowercase hex value.');
  if (owner.containmentKind !== 'windows-job' && owner.containmentKind !== 'systemd-user-service' && owner.containmentKind !== 'darwin-process-group') {
    throw new TypeError('Run process containment kind is unsupported.');
  }
  if (owner.state !== 'PREPARED') throw new TypeError('A new Run process owner must start PREPARED.');
  if (owner.systemdInvocationId !== null || owner.systemdControlGroup !== null || owner.supervisorPid !== null ||
      owner.supervisorStartIdentity !== null || owner.pid !== null || owner.platform !== null ||
      owner.processStartIdentity !== null || owner.executableIdentity !== null || owner.stopEvidence !== null) {
    throw new TypeError('OS process identity and stop evidence cannot be invented before launch.');
  }
  assertNonEmpty(owner.updatedAt, 'updatedAt');
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string.`);
}

function assertSourceSnapshotKey(value: string | null | undefined, containmentKind: RunContainmentKind): void {
  const platform = containmentKind === 'windows-job' ? 'win32' : 'linux';
  if (value !== null && value !== undefined && !isCanonicalSourceSnapshotKey(value, platform)) {
    throw new TypeError('Hermes source snapshot key must be the exact canonical versioned identity.');
  }
}

/** Проверяет bounded scalar JCS identity без чтения cache, source tree или Hermes config. */
function isCanonicalSourceSnapshotKey(
  value: unknown,
  platform: 'win32' | 'linux',
  allowLegacyWindowsRecovery = false,
): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  let identity: unknown;
  try {
    identity = JSON.parse(value);
  } catch {
    return false;
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  const fields = identity as Record<string, unknown>;
  const { formatVersion, hermesVersion, manifestDigest, materializationPolicyVersion, sourceCommit, sourceTree } = fields;
  const legacyWindowsIdentity = platform === 'win32' && allowLegacyWindowsRecovery &&
    Object.keys(fields).sort().join(',') === 'formatVersion,hermesVersion,manifestDigest,sourceCommit,sourceTree';
  const expectedKeys = platform === 'win32' && !legacyWindowsIdentity
    ? 'formatVersion,hermesVersion,manifestDigest,materializationPolicyVersion,sourceCommit,sourceTree'
    : 'formatVersion,hermesVersion,manifestDigest,sourceCommit,sourceTree';
  const isGitObjectId = (id: unknown): id is string =>
    typeof id === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id);
  if (Object.keys(fields).sort().join(',') !== expectedKeys || formatVersion !== 1 ||
      (platform === 'win32' && !legacyWindowsIdentity && materializationPolicyVersion !== 2) ||
      typeof hermesVersion !== 'string' || hermesVersion.length === 0 || hermesVersion.length > 256 ||
      !hermesVersion.isWellFormed() || [...hermesVersion].some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127;
      }) ||
      typeof manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifestDigest) ||
      !isGitObjectId(sourceCommit) || !isGitObjectId(sourceTree) || sourceCommit.length !== sourceTree.length) return false;
  // Порядок совпадает с JCS; Windows policy-v2 key не переиспользуется на Linux и наоборот.
  const canonicalIdentity = platform === 'win32' && !legacyWindowsIdentity
    ? { formatVersion, hermesVersion, manifestDigest, materializationPolicyVersion: 2, sourceCommit, sourceTree }
    : { formatVersion, hermesVersion, manifestDigest, sourceCommit, sourceTree };
  return value === JSON.stringify(canonicalIdentity);
}
