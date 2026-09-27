import { clearTimeout, setTimeout } from "node:timers";

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
