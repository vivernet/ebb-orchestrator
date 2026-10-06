import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import {
  WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES,
  type WindowsProcessScopeLaunchPhase,
} from "../../src/platform/process/windows-job-supervisor.js";

const OWNER_STATES = ["LIVE", "UNKNOWN", "OTHER", "UNAVAILABLE"] as const;
const SCOPE_INSPECTIONS = ["LIVE", "STOPPED", "UNKNOWN", "UNAVAILABLE"] as const;
const JOB_MEMBERSHIP_STATES = ["MEMBER", "NOT_MEMBER", "UNAVAILABLE"] as const;
const LAUNCH_PHASES = [...WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES, "UNAVAILABLE"] as const;
export const WINDOWS_PAYLOAD_CPU_ACTIVITY = [
  "LIVE_CPU_ADVANCED",
  "LIVE_CPU_IDLE",
  "EXITED",
  "IDENTITY_MISMATCH",
  "UNAVAILABLE",
] as const;

export type WindowsPayloadCpuActivity = (typeof WINDOWS_PAYLOAD_CPU_ACTIVITY)[number];
type WindowsPayloadOwnerState = (typeof OWNER_STATES)[number];
type WindowsPayloadScopeInspection = (typeof SCOPE_INSPECTIONS)[number];
type WindowsJobMembershipState = (typeof JOB_MEMBERSHIP_STATES)[number];

export interface WindowsPayloadMarkerTimeoutSnapshot {
  ownerState: WindowsPayloadOwnerState;
  ownerIdentityMatches: boolean;
  scopeInspection: WindowsPayloadScopeInspection;
  jobMembership: WindowsJobMembershipState;
  cpuActivity: WindowsPayloadCpuActivity;
  launchPhase: string;
  payloadMarkerPresent: boolean;
  descendantPidPresent: boolean;
  heartbeatPresent: boolean;
  descendantExitPresent: boolean;
  terminalStatusPresent: boolean;
}

export function parseWindowsPayloadCpuActivity(value: string): WindowsPayloadCpuActivity {
  return safeEnum(value, WINDOWS_PAYLOAD_CPU_ACTIVITY);
}

/** Читает фазу через переданный inspector ровно для persisted owner; ошибки и неизвестные значения становятся `UNAVAILABLE`. */
export async function inspectWindowsLaunchPhaseForTimeout(
  persistedOwner: ProcessScopeIdentity | undefined,
  inspectLaunchPhase: (owner: ProcessScopeIdentity) => Promise<unknown>,
): Promise<WindowsProcessScopeLaunchPhase> {
  if (!persistedOwner) return "UNAVAILABLE";
  try {
    return safeEnum(await inspectLaunchPhase(persistedOwner), LAUNCH_PHASES);
  } catch {
    return "UNAVAILABLE";
  }
}

/** Distinguishes exact membership outcomes without retaining untrusted process output. */
export function classifyWindowsJobMembershipResult(
  exitCode: number,
  stdout: string,
  stderr: string,
): WindowsJobMembershipState {
  if (exitCode === 0 && isExactSingleLine(stdout, "EXACT_PROCESS_JOB_MEMBERSHIP_CONFIRMED") && stderr.length === 0) {
    return "MEMBER";
  }
  if (exitCode === 1 && stdout.length === 0 && isExactSingleLine(stderr, "DESCENDANT_NOT_IN_NAMED_JOB")) {
    return "NOT_MEMBER";
  }
  return "UNAVAILABLE";
}

/**
 * Formats only fixed enums and booleans for a Windows payload-marker timeout.
 * LIVE_CPU_IDLE means no CPU-time movement in the 250 ms sample; it cannot distinguish a suspended
 * process from one blocked on I/O, waiting, or not scheduled during that interval.
 */
export function formatWindowsPayloadMarkerTimeout(
  snapshot: WindowsPayloadMarkerTimeoutSnapshot,
): string {
  const ownerState = safeEnum(snapshot.ownerState, OWNER_STATES);
  const scopeInspection = safeEnum(snapshot.scopeInspection, SCOPE_INSPECTIONS);
  const cpuActivity = safeEnum(snapshot.cpuActivity, WINDOWS_PAYLOAD_CPU_ACTIVITY);
  const launchPhase = safeEnum(snapshot.launchPhase, LAUNCH_PHASES);
  return [
    "PROCESS_SCOPE_PAYLOAD_MARKER_TIMEOUT",
    `ownerState=${ownerState}`,
    `ownerIdentityMatches=${snapshot.ownerIdentityMatches === true}`,
    `scopeInspection=${scopeInspection}`,
    `jobMembership=${safeEnum(snapshot.jobMembership, JOB_MEMBERSHIP_STATES)}`,
    `cpuActivity=${cpuActivity}`,
    `launchPhase=${launchPhase}`,
    `payloadMarkerPresent=${snapshot.payloadMarkerPresent === true}`,
    `descendantPidPresent=${snapshot.descendantPidPresent === true}`,
    `heartbeatPresent=${snapshot.heartbeatPresent === true}`,
    `descendantExitPresent=${snapshot.descendantExitPresent === true}`,
    `terminalStatusPresent=${snapshot.terminalStatusPresent === true}`,
  ].join(" ");
}

function isExactSingleLine(value: string, marker: string): boolean {
  return value === marker || value === `${marker}\n` || value === `${marker}\r\n`;
}

function safeEnum<const Values extends readonly string[]>(value: unknown, allowed: Values): Values[number] {
  return allowed.includes(value as Values[number]) ? value as Values[number] : "UNAVAILABLE" as Values[number];
}
