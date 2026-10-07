import { randomBytes } from 'node:crypto';
import type { Database, DatabaseTx } from '../../platform/database/database.js';
import type { ProcessScopeSupervisor } from '../../platform/process/run-scope-supervisor.js';
import type { ProcessScopeObservation } from '../../platform/process/process-inspector.js';

export type RunContainmentKind = 'windows-job' | 'systemd-user-service';
export type RunProcessOwnerState = 'PREPARED' | 'LAUNCHING' | 'LIVE' | 'STOPPING' | 'STOPPED' | 'UNKNOWN';

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
  if (containmentKind !== 'windows-job' && containmentKind !== 'systemd-user-service') {
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
      (containmentKind !== 'windows-job' && containmentKind !== 'systemd-user-service')) return false;
  if (value === 'NEVER_LAUNCHED' || value === 'LAUNCH_NOT_DISPATCHED') return true;
  return containmentKind === 'windows-job'
    ? value === 'WINDOWS_JOB_EMPTY' || value === 'WINDOWS_JOB_AND_HELPER_ABSENT'
    : value === 'SYSTEMD_CGROUP_EMPTY' || value === 'UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT';
}

/** Возвращает durable owner, проверяя SQLite values; historical source key остаётся NULL. */
export function getRunProcessOwner(database: Database | DatabaseTx, runId: string): RunProcessOwner | undefined {
  const row = database.get<Record<string, unknown>>(
    "SELECT * FROM run_process_owners WHERE run_id=$runId", { runId },
  );
  return row ? parseOwnerRow(row) : undefined;
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
      throw new Error(`RUN_PROCESS_SCOPE_UNKNOWN:${owner.runId}`);
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
  if (kind !== 'windows-job' && kind !== 'systemd-user-service') throw new Error('RUN_PROCESS_OWNER_INVALID');
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
  if (owner.containmentKind !== 'windows-job' && owner.containmentKind !== 'systemd-user-service') {
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
