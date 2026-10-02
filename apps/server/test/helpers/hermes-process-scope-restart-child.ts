import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { getRunProcessOwner, insertRunProcessOwnerTx, preflightRunProcessOwners, prepareRunProcessOwner, transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import { loadTestMigrations } from "./migrations.js";

const [mode, databasePath, runId, runHome, heartbeatPath, digestPath, descendantPidPath, descendantExitPath, markerPath] = process.argv.slice(2);

async function main(): Promise<void> {
  if (mode === "launch") {
    await launchOwnedScope();
    return;
  }
  if (mode === "recover") {
    await recoverOwnedScope();
    return;
  }
  process.stderr.write("PROCESS_SCOPE_RESTART_CHILD_MODE_INVALID\n");
  process.exitCode = 2;
}

async function launchOwnedScope(): Promise<void> {
  if (!databasePath || !runId || !runHome || !heartbeatPath || !digestPath || !descendantPidPath || !descendantExitPath || !markerPath) {
    throw new Error("PROCESS_SCOPE_RESTART_CHILD_ARGUMENTS_INVALID");
  }
  const database = createSqliteDatabase(databasePath);
  try {
    runMigrations(database, loadTestMigrations());
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','dummy-5a','STARTED',$startedAt)",
      { id: runId, startedAt: new Date().toISOString() },
    );
    const containmentKind = process.platform === "win32" ? "windows-job" : "systemd-user-service";
    const prepared = prepareRunProcessOwner(runId, runHome, containmentKind);
    database.transaction((tx) => {
      insertRunProcessOwnerTx(tx, prepared);
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
    });
    const supervisor = createSupervisor();
    const owner = toScopeIdentity(getRunProcessOwner(database, runId));
    const handle = await supervisor.launch(owner, buildRequest(runHome, heartbeatPath, digestPath, descendantPidPath, descendantExitPath), async (identity) => {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: {
          systemdInvocationId: identity.systemdInvocationId,
          systemdControlGroup: identity.systemdControlGroup,
          supervisorPid: identity.supervisorPid,
          supervisorStartIdentity: identity.supervisorStartIdentity,
          pid: identity.pid,
          platform: identity.platform,
          processStartIdentity: identity.processStartIdentity,
          executableIdentity: identity.executableIdentity,
        },
      }));
    });
    void handle.completion.catch(() => undefined);

    if (process.platform === "win32") {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: "LIVE", nextState: "UNKNOWN", evidence: "OS_STATE_UNPROVEN",
      }));
    }
    const persisted = getRunProcessOwner(database, runId);
    if (!persisted) throw new Error("RUN_PROCESS_OWNER_MISSING");
    await writeFile(markerPath, JSON.stringify({
      processId: process.pid,
      processGroupId: process.platform === "linux" ? process.pid : null,
      runId: persisted.runId,
      containmentId: persisted.containmentId,
      state: persisted.state,
      supervisorPid: persisted.supervisorPid,
      supervisorStartIdentity: persisted.supervisorStartIdentity,
      payloadPid: persisted.pid,
      platform: persisted.platform,
      systemdInvocationId: persisted.systemdInvocationId,
      systemdControlGroup: persisted.systemdControlGroup,
    }));
    await new Promise<void>(() => { setInterval(() => undefined, 60_000); });
  } finally {
    database.close();
  }
}

async function recoverOwnedScope(): Promise<void> {
  if (!databasePath || !runId || !markerPath) throw new Error("PROCESS_SCOPE_RESTART_CHILD_ARGUMENTS_INVALID");
  const database = createSqliteDatabase(databasePath);
  try {
    const before = getRunProcessOwner(database, runId);
    if (!before) throw new Error("RUN_PROCESS_OWNER_MISSING");
    await preflightRunProcessOwners(database, createSupervisor());
    const after = getRunProcessOwner(database, runId);
    if (!after) throw new Error("RUN_PROCESS_OWNER_MISSING");
    await writeFile(markerPath, JSON.stringify({
      ok: true,
      processId: process.pid,
      runId: after.runId,
      previousState: before.state,
      state: after.state,
      stopEvidence: after.stopEvidence,
      containmentId: after.containmentId,
      supervisorPid: after.supervisorPid,
      payloadPid: after.pid,
      platform: after.platform,
      systemdInvocationId: after.systemdInvocationId,
      systemdControlGroup: after.systemdControlGroup,
    }));
  } catch {
    await writeFile(markerPath, JSON.stringify({ ok: false, processId: process.pid, runId }));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

function createSupervisor(): WindowsJobSupervisor | SystemdRunSupervisor {
  if (process.platform === "win32") return new WindowsJobSupervisor(new ProcessExecutor());
  if (process.platform === "linux") return new SystemdRunSupervisor(new ProcessExecutor());
  throw new Error("PROCESS_SCOPE_RESTART_CHILD_PLATFORM_UNSUPPORTED");
}

function buildRequest(
  runHomeValue: string,
  heartbeat: string,
  digest: string,
  descendantPid: string,
  descendantExit: string,
) {
  const payloadSource = process.platform === "win32"
    ? windowsPayloadSource(heartbeat, digest, descendantPid, descendantExit)
    : linuxPayloadSource(digest, descendantPid);
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    HERMES_HOME: runHomeValue,
  };
  if (process.platform === "win32") {
    for (const [key, source] of [
      ["SYSTEMROOT", "SystemRoot"], ["TEMP", "TEMP"], ["TMP", "TMP"],
      ["HOMEDRIVE", "HOMEDRIVE"], ["HOMEPATH", "HOMEPATH"],
    ] as const) {
      const value = process.env[source];
      if (value !== undefined) environment[key] = value;
    }
  } else {
    environment.HOME = homedir();
  }
  return {
    executable: process.execPath,
    args: ["-e", payloadSource, descendantPid],
    cwd: dirname(runHomeValue),
    environment,
    timeoutMs: 60_000,
  };
}

function windowsPayloadSource(heartbeat: string, digest: string, descendantPid: string, descendantExit: string): string {
  const childPayload = [
    "const fs=require('node:fs');",
    "let count=0;",
    "fs.writeFileSync(process.argv[1],'0');",
    "setInterval(()=>fs.writeFileSync(process.argv[1],String(++count)),20);",
  ].join("");
  return [
    "const {spawn}=require('node:child_process');",
    "const fs=require('node:fs');",
    "if(process.env.EBB_HERMES_PROVIDER_API_KEY)process.exit(20);",
    `fs.writeFileSync(${JSON.stringify(digest)},'provider-free-dummy-payload');`,
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childPayload)},${JSON.stringify(heartbeat)}],{stdio:'ignore',windowsHide:true,detached:true});`,
    "child.once('error',()=>process.exit(21));",
    `child.once('exit',code=>fs.writeFileSync(${JSON.stringify(descendantExit)},String(code)));`,
    `child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(descendantPid)},String(child.pid));child.unref();process.stdout.write('dummy payload root complete\\n');});`,
  ].join("");
}

function linuxPayloadSource(digest: string, descendantPid: string): string {
  return [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "if(process.env.EBB_HERMES_PROVIDER_API_KEY)process.exit(20);",
    `writeFileSync(${JSON.stringify(digest)},'provider-free-dummy-payload');`,
    "const child=spawn('setsid',['/bin/sh','-c','sleep 60'],{stdio:'ignore'});",
    "child.once('error',()=>process.exit(21));",
    `child.once('spawn',()=>{writeFileSync(${JSON.stringify(descendantPid)},String(child.pid));child.unref();process.stdout.write('dummy payload root complete\\n');});`,
  ].join(" ");
}

function toScopeIdentity(owner: ReturnType<typeof getRunProcessOwner>): ProcessScopeIdentity {
  if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
  return {
    runId: owner.runId,
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
  };
}

void main().catch(() => {
  process.stderr.write("PROCESS_SCOPE_RESTART_CHILD_FAILED\n");
  process.exitCode = 1;
});
