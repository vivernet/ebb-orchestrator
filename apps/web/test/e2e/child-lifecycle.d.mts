import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function spawnManagedChild(command: string, args: string[], options?: SpawnOptions): ChildProcess;
export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<{
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}>;
export function terminateManagedChild(child: ChildProcess, options?: {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
}): Promise<{ exited: true; groupGone: true; escalated: boolean }>;
