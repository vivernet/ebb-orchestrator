import { execFile, spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Запускает управляемый E2E child и закрепляет за ним process-group ownership.
 *
 * На POSIX дочерний процесс начинает отдельную session/process group; её ID
 * сохраняется для bounded teardown потомков. На Windows detached остаётся false,
 * чтобы завершение продолжало использовать taskkill для дерева процессов.
 * Ошибки фактического запуска сообщаются стандартным событием ChildProcess.
 *
 * @param {string} command Исполняемый файл для запуска.
 * @param {string[]} args Аргументы исполняемого файла.
 * @param {import("node:child_process").SpawnOptions} options Параметры `spawn`, кроме платформенного `detached`.
 * @returns {import("node:child_process").ChildProcess} ChildProcess с POSIX `ownedProcessGroupId`, когда применимо.
 */
export function spawnManagedChild(command, args, options = {}) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, { ...options, detached });
  if (detached) {
    child.ownedProcessGroupId = child.pid;
    const captureIdentity = () => {
      if (child.ownedProcessIdentity) return;
      child.ownedProcessIdentity = readLinuxProcessIdentity(child.pid);
    };
    captureIdentity();
    child.once("spawn", captureIdentity);
  }
  return child;
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Читает kernel start ticks и session identity Linux process из `/proc`.
 * На других платформах возвращает `undefined`, чтобы teardown не сигналил группу
 * без сильной process identity.
 *
 * @param {number} pid PID проверяемого процесса.
 * @returns {{ pid: number, processGroupId: number, sessionId: number, startTicks: string } | undefined} Kernel identity или отсутствие поддерживаемого источника.
 */
export function readLinuxProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const startTicks = fields[19];
    if (!Number.isInteger(processGroupId) || !Number.isInteger(sessionId) || !/^\d+$/.test(startTicks ?? "")) return undefined;
    return { pid, processGroupId, sessionId, startTicks };
  } catch {
    return undefined;
  }
}

function readDetachedGroupLedger(ledgerPath, groups) {
  let ledgerFd;
  try {
    if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw new Error("Detached process ledger cannot be opened without symlink protection");
    ledgerFd = openSync(ledgerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(ledgerFd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Detached process ledger is not a private regular file");
    }
    const contents = readFileSync(ledgerFd, "utf8");
    if (contents && !contents.endsWith("\n")) throw new Error("Detached process ledger ends with an incomplete record");
    for (const line of contents.split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.version !== 1 || record.type !== "detached-process-group"
          || !Number.isInteger(record.pid) || record.pid <= 0
          || !Number.isInteger(record.processGroupId) || record.processGroupId <= 0) {
        throw new Error("Detached process ledger contains an invalid ownership record");
      }
      const identity = {
        leaderPid: record.pid,
        processGroupId: record.processGroupId,
        sessionId: record.sessionId,
        startTicks: record.startTicks,
      };
      const existing = groups.get(identity.processGroupId);
      if (existing) {
        const existingStrong = typeof existing.startTicks === "string" && Number.isInteger(existing.sessionId);
        const incomingStrong = typeof identity.startTicks === "string" && Number.isInteger(identity.sessionId);
        if (existing.leaderPid !== identity.leaderPid
            || (existingStrong && incomingStrong && (existing.sessionId !== identity.sessionId || existing.startTicks !== identity.startTicks))) {
          throw new Error(`Detached process ledger reports conflicting identities for process group ${identity.processGroupId}`);
        }
        if (existingStrong || !incomingStrong) continue;
      }
      groups.set(identity.processGroupId, identity);
    }
  } catch (error) {
    groups.error ??= error;
  } finally {
    if (ledgerFd !== undefined) closeSync(ledgerFd);
  }
}

/**
 * Считывает append-only ledger, который preload синхронно заполняет при каждом
 * `child_process.spawn(..., { detached: true })`. PID и group identity остаются доступны
 * после reparenting или выхода leader. На Windows используется системный `/T`.
 *
 * @param {import("node:child_process").ChildProcess & { ownedDetachedProcessGroups?: Map<number, object> }} child Управляемый процесс, чьё дерево требуется наблюдать.
 * @param {{ pollIntervalMs?: number, ledgerPath?: string }} options Интервал чтения ledger и путь к нему.
 * @returns {{ error?: Error }} Состояние наблюдателя; найденные session leaders записываются на child.
 */
export function monitorDetachedProcessGroups(child, { pollIntervalMs = 100, ledgerPath = process.env.EBB_E2E_PROCESS_GROUP_LEDGER } = {}) {
  if (process.platform === "win32") return { error: undefined };
  child.ownedDetachedProcessGroups ??= new Map();
  const monitor = { error: undefined, pollingStopped: false, ledgerPath };
  const refresh = () => {
    if (!ledgerPath) {
      monitor.error ??= new Error("Detached process ledger path is unavailable");
      return;
    }
    readDetachedGroupLedger(ledgerPath, child.ownedDetachedProcessGroups);
    monitor.error ??= child.ownedDetachedProcessGroups.error;
  };
  monitor.refresh = refresh;
  refresh();
  monitor.timer = setInterval(() => {
    if (!monitor.pollingStopped) refresh();
  }, pollIntervalMs);
  monitor.timer.unref?.();
  child.detachedProcessGroupMonitor = monitor;
  return monitor;
}

function pauseDetachedProcessGroupPolling(child) {
  const monitor = child.detachedProcessGroupMonitor;
  if (!monitor) return;
  monitor.pollingStopped = true;
  clearInterval(monitor.timer);
}

function refreshDetachedProcessOwnership(child) {
  const monitor = child.detachedProcessGroupMonitor;
  monitor?.refresh?.();
  const groups = child.ownedDetachedProcessGroups ?? new Map();
  return {
    groups: [...groups.values()],
    error: monitor?.error ?? groups.error ?? child.detachedProcessGroupLedgerError,
  };
}

function sameStrongIdentity(current, expected) {
  return Boolean(current && expected
    && current.pid === expected.leaderPid
    && current.processGroupId === expected.processGroupId
    && current.sessionId === expected.sessionId
    && current.processGroupId === current.pid
    && current.sessionId === current.pid
    && typeof current.startTicks === "string"
    && current.startTicks === expected.startTicks);
}

function inspectDetachedProcessGroups(groups, processIdentityProvider = readLinuxProcessIdentity, processGroupExistsProvider = processGroupExists) {
  return groups.map((group) => {
    const groupExists = processGroupExistsProvider(group.processGroupId);
    const leaderVerified = sameStrongIdentity(processIdentityProvider(group.leaderPid), group);
    return { ...group, exists: groupExists, leaderVerified };
  });
}

function readDetachedGroupStatus(groups, processIdentityProvider = readLinuxProcessIdentity, processGroupExistsProvider = processGroupExists) {
  if (groups.length === 0) return { groups: [], error: undefined };
  try {
    return { groups: inspectDetachedProcessGroups(groups, processIdentityProvider, processGroupExistsProvider), error: undefined };
  } catch (error) {
    return { groups: groups.map((group) => ({ ...group, exists: true, leaderVerified: false })), error };
  }
}

function managedProcessesGone(status) {
  return status.exited && status.rootGroupGone && status.detachedGroups.every((group) => !group.exists);
}

function sameDetachedGroupSnapshot(left, right) {
  if (left.length !== right.length) return false;
  const rightByGroupId = new Map(right.map((group) => [group.processGroupId, group]));
  return left.every((group) => {
    const other = rightByGroupId.get(group.processGroupId);
    return other && group.leaderPid === other.leaderPid && group.sessionId === other.sessionId && group.startTicks === other.startTicks;
  });
}

function readManagedProcessStatus(child, processGroupId, ownership, observerError, processIdentityProvider, processGroupExistsProvider) {
  const detached = readDetachedGroupStatus(ownership.groups, processIdentityProvider, processGroupExistsProvider);
  return {
    exited: childHasExited(child),
    rootGroupGone: !processGroupExistsProvider(processGroupId),
    detachedGroups: detached.groups,
    observerError: observerError ?? ownership.error ?? detached.error,
  };
}

function confirmManagedProcessesQuiescent(child, processGroupId, refreshOwnership, processIdentityProvider, processGroupExistsProvider) {
  const ownership = refreshOwnership();
  const status = readManagedProcessStatus(child, processGroupId, ownership, ownership.error, processIdentityProvider, processGroupExistsProvider);
  if (status.observerError || !managedProcessesGone(status)) return { complete: false, status };

  // Every process group was observed empty before this second synchronous ledger read.
  // A process that spawned a new detached group before exiting must have appended it first.
  const finalOwnership = refreshOwnership();
  if (finalOwnership.error || !sameDetachedGroupSnapshot(ownership.groups, finalOwnership.groups)) {
    const finalStatus = readManagedProcessStatus(child, processGroupId, finalOwnership, finalOwnership.error, processIdentityProvider, processGroupExistsProvider);
    return { complete: false, status: finalStatus };
  }
  return { complete: true, status };
}

async function waitForManagedGroupsAndChild(child, processGroupId, refreshOwnership, timeoutMs, pollIntervalMs, processIdentityProvider, processGroupExistsProvider, onDetachedGroups) {
  const deadline = Date.now() + timeoutMs;
  let status;
  let observerError;
  const signalFailures = [];
  do {
    let ownership = refreshOwnership();
    observerError ??= ownership.error;
    let detached = readDetachedGroupStatus(ownership.groups, processIdentityProvider, processGroupExistsProvider);
    observerError ??= detached.error;
    signalFailures.push(...onDetachedGroups(detached.groups));

    ownership = refreshOwnership();
    observerError ??= ownership.error;
    detached = readDetachedGroupStatus(ownership.groups, processIdentityProvider, processGroupExistsProvider);
    observerError ??= detached.error;
    status = readManagedProcessStatus(child, processGroupId, { ...ownership, groups: detached.groups }, observerError, processIdentityProvider, processGroupExistsProvider);
    if (managedProcessesGone(status) && !status.observerError) {
      const quiescent = confirmManagedProcessesQuiescent(child, processGroupId, refreshOwnership, processIdentityProvider, processGroupExistsProvider);
      observerError ??= quiescent.status.observerError;
      if (quiescent.complete) return { ...quiescent.status, observerError, signalFailures, quiescent: true };
      status = { ...quiescent.status, observerError };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  } while (Date.now() < deadline);
  return { ...status, observerError, signalFailures, quiescent: false };
}

function signalVerifiedDetachedGroups(groups, signal, onEvent, processIdentityProvider = readLinuxProcessIdentity, signalProcessGroupProvider = signalProcessGroup, signalledGroupIds = new Set()) {
  const failures = [];
  for (const group of groups) {
    if (!group.exists || signalledGroupIds.has(group.processGroupId)) continue;
    if (!group.leaderVerified || !sameStrongIdentity(processIdentityProvider(group.leaderPid), group)) {
      emitLifecycleEvent(onEvent, "signal-result", { signal, sent: false, processGroupId: group.processGroupId, ownershipVerified: false });
      continue;
    }
    signalledGroupIds.add(group.processGroupId);
    let sent = false;
    try { sent = signalProcessGroupProvider(group.processGroupId, signal); } catch (error) { failures.push(error); }
    emitLifecycleEvent(onEvent, "signal-result", { signal, sent, processGroupId: group.processGroupId, ownershipVerified: true });
  }
  return failures;
}

function isRootSessionLeader(identity, childPid) {
  return Boolean(identity
    && identity.pid === childPid
    && identity.processGroupId === childPid
    && identity.sessionId === childPid
    && typeof identity.startTicks === "string"
    && identity.startTicks.length > 0);
}

function signalVerifiedRootGroup(identity, child, signal, processIdentityProvider, processGroupExistsProvider, signalProcessGroupProvider) {
  if (!identity) {
    if (processGroupExistsProvider(child.ownedProcessGroupId)) {
      return { sent: false, error: new Error(`E2E root process group identity is ambiguous before ${signal}; refusing to signal (pid=${child.pid})`) };
    }
    return { sent: false, error: undefined };
  }
  const current = processIdentityProvider(identity.pid);
  const identityMatches = isRootSessionLeader(identity, child.pid) && sameStrongIdentity(current, {
    leaderPid: identity.pid,
    processGroupId: identity.processGroupId,
    sessionId: identity.sessionId,
    startTicks: identity.startTicks,
  });
  if (!identityMatches) {
    const groupExists = processGroupExistsProvider(identity.processGroupId);
    return {
      sent: false,
      error: groupExists
        ? new Error(`E2E root process identity changed before ${signal}; refusing to signal process group ${identity.processGroupId}`)
        : undefined,
    };
  }
  return { sent: signalProcessGroupProvider(identity.processGroupId, signal), error: undefined };
}

function emitLifecycleEvent(onEvent, event, details = {}) {
  onEvent?.(event, details);
}

/**
 * Завершает Windows E2E child через `taskkill` и сохраняет диагностические детали отказа.
 *
 * Проверяет фактический exit child независимо от ответа `taskkill`; при непроверенном
 * завершении ошибка сохраняет PID, exit state, код команды и ограниченный stderr.
 * Providers инъецируются только для детерминированной проверки Windows-ветки на других ОС.
 *
 * @param {import("node:child_process").ChildProcess} child E2E child, которым владеет launcher.
 * @param {object} options Ограничение ожидания и test providers для `taskkill` и exit polling.
 * @returns {Promise<{ exited: true, groupGone: true, escalated: false }>} Подтверждённый teardown.
 * @throws {Error} Если child не завершён или ответ `taskkill` сообщает об ошибке.
 */
export function terminateWindowsChild(child, {
  timeoutMs,
  onEvent,
  execFileProvider = execFile,
  waitForChildExitProvider = waitForChildExit,
}) {
  return new Promise((resolvePromise, reject) => {
    const finish = (error, value) => error ? reject(error) : resolvePromise(value);
    const waitForExit = (taskkillError, taskkillStderr) => waitForChildExitProvider(child, timeoutMs).then((exit) => {
      const stderr = String(taskkillStderr ?? taskkillError?.stderr ?? "").trim().slice(0, 512);
      const diagnostics = [
        `pid=${child.pid ?? "none"}`,
        `exitCode=${exit.code ?? (exit.signal ? "none" : child.exitCode === null ? "running" : child.exitCode)}`,
        `signalCode=${exit.signal ?? child.signalCode ?? "none"}`,
        `taskkillCode=${taskkillError?.code ?? (taskkillError ? "unknown" : "none")}`,
        ...(stderr ? [`taskkillStderr=${JSON.stringify(stderr)}`] : []),
      ].join(", ");
      const causeOptions = taskkillError ? { cause: taskkillError } : undefined;
      if (!exit.exited) return finish(new Error(`Windows E2E child did not exit after taskkill (${diagnostics})`, causeOptions));
      if (taskkillError) return finish(new Error(`Windows taskkill did not verify process-tree teardown (${diagnostics})`, causeOptions));
      finish(undefined, { exited: true, groupGone: true, escalated: false });
    }, finish);

    if (childHasExited(child) || !child.pid) return waitForExit();
    emitLifecycleEvent(onEvent, "termination-requested", { method: "taskkill" });
    execFileProvider("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true }, (error, _stdout, stderr) => {
      const diagnosticStderr = String(stderr ?? error?.stderr ?? "").trim().slice(0, 512);
      emitLifecycleEvent(onEvent, "taskkill-result", {
        succeeded: !error,
        errorCode: error?.code ?? null,
        stderr: diagnosticStderr || null,
      });
      waitForExit(error, diagnosticStderr);
    });
  });
}

/**
 * Останавливает принадлежащий E2E runner child и подтверждает завершение процесса и его группы.
 *
 * На POSIX функция посылает SIGTERM принадлежащей child группе и подтверждённым
 * detached session groups, ждёт заданный срок, затем при необходимости посылает SIGKILL
 * только группам с повторно проверенным leader identity. Исчезновение каждой группы
 * подтверждается в ограниченный срок. На Windows сохраняет `taskkill.exe /T /F`.
 * Если teardown или ownership нельзя подтвердить, функция бросает ошибку; вызывающий
 * код должен сохранить изолированный home.
 *
 * @param {import("node:child_process").ChildProcess & { ownedProcessGroupId?: number }} child Процесс, созданный `spawnManagedChild`.
 * @param {{ termTimeoutMs?: number, killTimeoutMs?: number, pollIntervalMs?: number, onEvent?: (event: string, details: object) => void }} options Сроки ожидания и канал lifecycle evidence.
 * @returns {Promise<{ exited: true, groupGone: true, escalated: boolean }>} Подтверждённый результат teardown.
 * @throws {Error} Если владение группой, завершение child или исчезновение группы не доказано.
 */
export async function terminatePosixManagedChild(child, {
  termTimeoutMs = 10_000,
  killTimeoutMs = 5_000,
  pollIntervalMs = 25,
  onEvent,
  processIdentityProvider = readLinuxProcessIdentity,
  processGroupExistsProvider = processGroupExists,
  signalProcessGroupProvider = signalProcessGroup,
} = {}) {
  pauseDetachedProcessGroupPolling(child);
  const refreshOwnership = () => refreshDetachedProcessOwnership(child);
  const detachedOwnership = refreshOwnership();
  const processGroupId = child.ownedProcessGroupId;
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    if (!child.pid && childHasExited(child) && detachedOwnership.groups.length === 0) {
      if (detachedOwnership.error) throw new Error(`Detached E2E process groups could not be monitored: ${detachedOwnership.error.message}`);
      return { exited: true, groupGone: true, escalated: false };
    }
    throw new Error("E2E child process-group ownership cannot be proven");
  }

  if (detachedOwnership.error) {
    throw new Error(`E2E detached process-group ownership is unknown; refusing all signals: ${detachedOwnership.error.message}`);
  }
  if (child.detachedProcessGroupLedgerError) {
    throw new Error("E2E detached process-group ledger failed; refusing all signals");
  }
  const rootIdentity = child.ownedProcessIdentity;
  if (rootIdentity && !isRootSessionLeader(rootIdentity, child.pid)) {
    throw new Error(`E2E root process identity is not a confirmed session leader; refusing to signal (pid=${child.pid})`);
  }
  emitLifecycleEvent(onEvent, "termination-requested", { method: "process-group", processGroupId });
  const termRoot = signalVerifiedRootGroup(rootIdentity, child, "SIGTERM", processIdentityProvider, processGroupExistsProvider, signalProcessGroupProvider);
  if (termRoot.error) throw termRoot.error;
  const termSent = termRoot.sent;
  emitLifecycleEvent(onEvent, "signal-result", { signal: "SIGTERM", sent: termSent, processGroupId });
  const termSignalledGroupIds = new Set();
  const signalTermForGroups = (groups) => {
    return signalVerifiedDetachedGroups(groups, "SIGTERM", onEvent, processIdentityProvider, signalProcessGroupProvider, termSignalledGroupIds);
  };
  let result = await waitForManagedGroupsAndChild(
    child,
    processGroupId,
    refreshOwnership,
    termTimeoutMs,
    pollIntervalMs,
    processIdentityProvider,
    processGroupExistsProvider,
    signalTermForGroups,
  );
  const signalFailures = [...result.signalFailures];
  if (result.observerError) {
    throw new Error(`E2E detached process-group ownership became unknown during TERM: ${result.observerError.message}`);
  }
  const termComplete = result.quiescent;
  let escalated = false;

  if (!termComplete) {
    escalated = true;
    const killRoot = signalVerifiedRootGroup(rootIdentity, child, "SIGKILL", processIdentityProvider, processGroupExistsProvider, signalProcessGroupProvider);
    if (killRoot.error) throw killRoot.error;
    emitLifecycleEvent(onEvent, "signal-result", { signal: "SIGKILL", sent: killRoot.sent, processGroupId });
    const killSignalledGroupIds = new Set();
    const signalKillForGroups = (groups) => {
      const lateTermFailures = signalVerifiedDetachedGroups(
        groups.filter((group) => !termSignalledGroupIds.has(group.processGroupId)),
        "SIGTERM",
        onEvent,
        processIdentityProvider,
        signalProcessGroupProvider,
        termSignalledGroupIds,
      );
      const killFailures = signalVerifiedDetachedGroups(
        groups,
        "SIGKILL",
        onEvent,
        processIdentityProvider,
        signalProcessGroupProvider,
        killSignalledGroupIds,
      );
      return [...lateTermFailures, ...killFailures];
    };
    result = await waitForManagedGroupsAndChild(
      child,
      processGroupId,
      refreshOwnership,
      killTimeoutMs,
      pollIntervalMs,
      processIdentityProvider,
      processGroupExistsProvider,
      signalKillForGroups,
    );
    signalFailures.push(...result.signalFailures);
  }

  if (!result.quiescent || !managedProcessesGone(result)) {
    throw new Error(`E2E process teardown could not be verified (pid=${child.pid ?? "none"}, processGroupId=${processGroupId}, exited=${result.exited}, rootGroupGone=${result.rootGroupGone}, detachedGroups=${result.detachedGroups.filter((group) => group.exists).map((group) => `${group.processGroupId}:${group.leaderVerified ? "owned" : "unverified"}`).join(",") || "none"})`);
  }
  if (detachedOwnership.error || result.observerError || signalFailures.length > 0) {
    const reasons = [detachedOwnership.error, result.observerError, ...signalFailures].filter(Boolean).map((error) => error.message);
    throw new Error(`E2E detached process-group cleanup is fail-closed: ${reasons.join("; ")}`);
  }
  const finalOwnership = refreshOwnership();
  if (finalOwnership.error || !sameDetachedGroupSnapshot(result.detachedGroups, finalOwnership.groups)) {
    throw new Error(`E2E detached process-group ledger changed after quiescence; isolated home must be retained${finalOwnership.error ? `: ${finalOwnership.error.message}` : ""}`);
  }
  emitLifecycleEvent(onEvent, "termination-verified", { processGroupId, detachedProcessGroups: finalOwnership.groups.map((group) => group.processGroupId), escalated });
  return { exited: true, groupGone: true, escalated };
}

/**
 * Выбирает platform-specific механизм bounded teardown для управляемого E2E child.
 * Windows использует `taskkill.exe /T /F`; POSIX проверяет root session identity и
 * делегирует процесс-группы специализированному cleanup с ownership gates.
 *
 * @param {import("node:child_process").ChildProcess & { ownedProcessGroupId?: number }} child Управляемый процесс.
 * @param {object} options Сроки ожидания, lifecycle callback и внутренние process providers для тестов.
 * @returns {Promise<{ exited: true, groupGone: true, escalated: boolean }>} Подтверждённый teardown.
 */
export async function terminateManagedChild(child, options = {}) {
  const { termTimeoutMs = 10_000, onEvent } = options;
  if (process.platform === "win32") return terminateWindowsChild(child, { timeoutMs: termTimeoutMs, onEvent });
  return terminatePosixManagedChild(child, options);
}

export function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const finish = (result, error) => {
      cleanup();
      if (error) reject(error);
      else resolvePromise(result);
    };
    const onExit = (code, signal) => finish({ exited: true, code, signal });
    const onError = (error) => finish(undefined, error);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    } else {
      timer = setTimeout(() => finish({ exited: false, code: null, signal: null }), timeoutMs);
    }
  });
}
