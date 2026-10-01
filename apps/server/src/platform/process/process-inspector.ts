import { readdir, readFile, stat } from "node:fs/promises";
import { posix } from "node:path";

export type ProcessScopeState = "PREPARED" | "LAUNCHING" | "LIVE" | "STOPPING" | "STOPPED" | "UNKNOWN";
export type ProcessScopeContainmentKind = "windows-job" | "systemd-user-service";

/** Durable lookup identity supplied by the Run owner row. */
export interface ProcessScopeIdentity {
  runId: string;
  containmentKind: ProcessScopeContainmentKind;
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
  state: ProcessScopeState;
}

export type ProcessScopeObservation =
  | { state: "LIVE"; identity: ProcessScopeIdentity }
  | { state: "STOPPED"; evidence: string }
  | { state: "UNKNOWN"; reason: string };

/** Даёт read-only наблюдение над тем же OS-owned scope, который запускает supervisor. */
export interface ProcessInspector {
  inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation>;
}

export interface SystemdScopeSnapshot {
  /** True only when the same-user manager successfully answered `systemctl show` for this unit. */
  managerQuerySucceeded: boolean;
  /** Where the exact expected unit cgroup path came from, or null when it could not be established. */
  controlGroupSource: "persisted-owner" | "unit-readback" | null;
  /** Exact cgroup path whose tree was inspected; it is never inferred from an empty unit response. */
  expectedControlGroup: string | null;
  unitFound: boolean;
  pendingJob: boolean;
  activeState: string | null;
  subState: string | null;
  description: string | null;
  invocationId: string | null;
  controlGroup: string | null;
  mainPid: number | null;
  type: string | null;
  exitType: string | null;
  killMode: string | null;
  delegate: string | null;
  protectControlGroups: string | null;
  restart: string | null;
  cgroupExists: boolean;
  cgroupReadable: boolean;
  cgroupPopulated: boolean | null;
  cgroupProcessIds: number[];
}

/**
 * Классифицирует systemd/cgroup v2 readback по durable unit, nonce и effective properties.
 * Ни PID, ни состояние главного процесса отдельно не доказывают остановку scope.
 *
 * @param owner Durable Run identity до обращения к менеджеру ОС.
 * @param snapshot Результат `systemctl show`, pending-job query и полного cgroup-tree readback.
 * @returns LIVE только для совпавшего unit с populated cgroup; STOPPED только для проверенного пустого scope.
 */
export function classifySystemdScope(
  owner: ProcessScopeIdentity,
  snapshot: SystemdScopeSnapshot,
): ProcessScopeObservation {
  if (!snapshot.managerQuerySucceeded) {
    return { state: "UNKNOWN", reason: "SYSTEMD_MANAGER_QUERY_UNAVAILABLE" };
  }
  const expectedPathIsValid = typeof snapshot.expectedControlGroup === "string" &&
    posix.isAbsolute(snapshot.expectedControlGroup) && !snapshot.expectedControlGroup.includes("\0");
  if (!snapshot.unitFound) {
    // Unit absence is STOPPED only when its exact ControlGroup was persisted from a prior
    // successful Unit.ControlGroup readback. Never derive a cgroup path from a unit name.
    if (owner.systemdControlGroup === null || snapshot.controlGroupSource !== "persisted-owner" ||
        snapshot.expectedControlGroup !== owner.systemdControlGroup || !expectedPathIsValid) {
      return { state: "UNKNOWN", reason: "SYSTEMD_UNIT_ABSENCE_UNPROVEN" };
    }
    if (snapshot.controlGroup !== null || snapshot.pendingJob || snapshot.cgroupExists || !snapshot.cgroupReadable ||
        snapshot.cgroupPopulated !== false || snapshot.cgroupProcessIds.length > 0) {
      return { state: "UNKNOWN", reason: "SYSTEMD_UNIT_ABSENCE_UNPROVEN" };
    }
    return { state: "STOPPED", evidence: "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT" };
  }
  if (!snapshot.cgroupReadable || snapshot.cgroupPopulated === null) {
      return { state: "UNKNOWN", reason: "CGROUP_READ_UNAVAILABLE" };
  }
  if (snapshot.controlGroupSource !== "unit-readback" || !expectedPathIsValid ||
      snapshot.controlGroup !== snapshot.expectedControlGroup ||
      (owner.systemdControlGroup !== null && snapshot.expectedControlGroup !== owner.systemdControlGroup)) {
    return { state: "UNKNOWN", reason: "SYSTEMD_CONTROL_GROUP_READBACK_MISMATCH" };
  }
  if (snapshot.description !== `ebb-orchestrator:${owner.launchNonce}` ||
      !snapshot.invocationId || !/^[a-f0-9-]{32,36}$/i.test(snapshot.invocationId) ||
      (owner.systemdInvocationId !== null && snapshot.invocationId !== owner.systemdInvocationId) ||
      !snapshot.controlGroup?.startsWith("/") ||
      snapshot.controlGroup !== snapshot.expectedControlGroup) {
    return { state: "UNKNOWN", reason: "SYSTEMD_IDENTITY_MISMATCH" };
  }
  if (snapshot.type !== "exec" || snapshot.exitType !== "cgroup" || snapshot.killMode !== "control-group" ||
      snapshot.delegate !== "no" || snapshot.protectControlGroups !== "yes" || snapshot.restart !== "no") {
    return { state: "UNKNOWN", reason: "SYSTEMD_CONTAINMENT_PROPERTY_MISMATCH" };
  }
  const populated = snapshot.cgroupPopulated || snapshot.cgroupProcessIds.length > 0;
  if (populated) {
    if (snapshot.activeState !== "active" && snapshot.activeState !== "activating" && snapshot.activeState !== "deactivating") {
      return { state: "UNKNOWN", reason: "SYSTEMD_CGROUP_UNIT_STATE_MISMATCH" };
    }
    return {
      state: "LIVE",
      identity: {
        ...owner,
        state: "LIVE",
        systemdInvocationId: snapshot.invocationId,
        systemdControlGroup: snapshot.controlGroup,
        pid: snapshot.mainPid && snapshot.mainPid > 0 ? snapshot.mainPid : owner.pid,
        platform: "linux",
      },
    };
  }
  if (snapshot.activeState === "active" || snapshot.activeState === "activating" || snapshot.activeState === "deactivating") {
    return { state: "UNKNOWN", reason: "SYSTEMD_EMPTY_ACTIVE_UNIT" };
  }
  return { state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" };
}

export interface CgroupFileAccess {
  readText(path: string): Promise<string>;
  list(path: string): Promise<readonly { name: string; isDirectory: boolean }[]>;
}

/**
 * Снимает recursive cgroup v2 membership; ошибка любого вложенного узла делает readback неполным.
 * Пути из systemd проверяются на абсолютность и containment в корневом cgroup mount.
 */
export async function inspectCgroupTree(
  controlGroup: string,
  access: CgroupFileAccess = nativeCgroupFileAccess,
  cgroupRoot = "/sys/fs/cgroup",
): Promise<{ exists: boolean; readable: boolean; populated: boolean | null; processIds: number[] }> {
  if (!posix.isAbsolute(controlGroup) || controlGroup.includes("\0")) {
    return { exists: false, readable: false, populated: null, processIds: [] };
  }
  const root = posix.normalize(cgroupRoot);
  const target = posix.normalize(posix.join(root, controlGroup.replace(/^[/\\]+/, "")));
  const relativePath = posix.relative(root, target);
  if (relativePath === ".." || relativePath.startsWith("../") || posix.isAbsolute(relativePath)) {
    return { exists: false, readable: false, populated: null, processIds: [] };
  }
  let rootStat: boolean;
  try { rootStat = await stat(target).then((value) => value.isDirectory()); }
  catch (error) {
    if (isMissing(error)) return { exists: false, readable: true, populated: false, processIds: [] };
    return { exists: true, readable: false, populated: null, processIds: [] };
  }
  if (!rootStat) return { exists: false, readable: true, populated: false, processIds: [] };

  let populated = false;
  const processIds: number[] = [];
  const pending = [target];
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      const [events, processes, entries] = await Promise.all([
        access.readText(posix.join(directory, "cgroup.events")),
        access.readText(posix.join(directory, "cgroup.procs")),
        access.list(directory),
      ]);
      const populatedMatch = /^populated\s+([01])$/m.exec(events);
      if (!populatedMatch) return { exists: true, readable: false, populated: null, processIds: [] };
      if (populatedMatch[1] === "1") populated = true;
      for (const line of processes.split(/\r?\n/)) {
        if (!line) continue;
        if (!/^[1-9]\d*$/.test(line)) return { exists: true, readable: false, populated: null, processIds: [] };
        processIds.push(Number(line));
        populated = true;
      }
      for (const entry of entries) {
        if (entry.isDirectory && entry.name !== "." && entry.name !== "..") pending.push(posix.join(directory, entry.name));
      }
    }
  } catch {
    return { exists: true, readable: false, populated: null, processIds: [] };
  }
  return { exists: true, readable: true, populated, processIds: [...new Set(processIds)] };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

const nativeCgroupFileAccess: CgroupFileAccess = {
  readText: (file) => readFile(file, "utf8"),
  list: async (directory) => (await readdir(directory, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  })),
};
