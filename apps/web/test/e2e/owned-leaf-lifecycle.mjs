import { waitForChildExit } from "./child-lifecycle.mjs";

function emitLifecycleEvent(onEvent, event, details = {}) {
  onEvent?.(event, details);
}

/**
 * Завершает один принадлежащий runner leaf-процесс и подтверждает его exit.
 *
 * Используется только для Windows Vite frontend, запущенного напрямую runner-ом.
 * Функция посылает сигнал только этому ChildProcess и не заявляет об очистке дерева.
 *
 * @param {import("node:child_process").ChildProcess} child Прямой дочерний процесс runner-а без управляемых потомков.
 * @param {{ timeoutMs?: number, onEvent?: (event: string, details: object) => void, waitForChildExitProvider?: typeof waitForChildExit }} options Ограниченный срок и test seam для проверки exit.
 * @returns {Promise<{ exited: true }>} Подтверждение завершения именно этого процесса.
 * @throws {Error} Если PID отсутствует либо процесс не завершился в пределах срока.
 */
export async function terminateWindowsOwnedLeaf(child, {
  timeoutMs = 10_000,
  onEvent,
  waitForChildExitProvider = waitForChildExit,
} = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error("Windows E2E owned leaf has no verifiable PID");
  }

  emitLifecycleEvent(onEvent, "termination-requested", { method: "child.kill", pid: child.pid });
  let accepted = false;
  let killError;
  try {
    accepted = child.kill();
  } catch (error) {
    killError = error;
  }

  const exit = await waitForChildExitProvider(child, timeoutMs);
  if (!exit.exited) {
    const reason = killError?.code ?? killError?.name ?? (accepted ? "timeout" : "signal-not-accepted");
    throw new Error(`Windows E2E owned leaf did not exit (pid=${child.pid}, killAccepted=${accepted}, reason=${reason})`,
      killError ? { cause: killError } : undefined);
  }

  emitLifecycleEvent(onEvent, "termination-verified", {
    pid: child.pid,
    code: exit.code,
    signal: exit.signal,
  });
  return { exited: true };
}
