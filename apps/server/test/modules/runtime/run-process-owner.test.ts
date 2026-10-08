import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database, DatabaseTx } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { getRunProcessOwner, insertRunProcessOwnerTx, prepareRunProcessOwner, preflightRunProcessOwners, transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import { safeRestartChildFailureCode } from "../../helpers/restart-child-diagnostics.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeSupervisor } from "../../../src/platform/process/run-scope-supervisor.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const snapshotIdentity = {
  formatVersion: 1,
  hermesVersion: "v0.21.5+9117.g08165d5",
  manifestDigest: "a".repeat(64),
  sourceCommit: "b".repeat(40),
  sourceTree: "c".repeat(40),
};
const snapshotKey = JSON.stringify(snapshotIdentity);
const windowsSnapshotKey = JSON.stringify({
  formatVersion: snapshotIdentity.formatVersion,
  hermesVersion: snapshotIdentity.hermesVersion,
  manifestDigest: snapshotIdentity.manifestDigest,
  materializationPolicyVersion: 2,
  sourceCommit: snapshotIdentity.sourceCommit,
  sourceTree: snapshotIdentity.sourceTree,
});

describe("Run process owner", () => {
  let directory = "";
  let db: Database | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function setup(): Promise<Database> {
    directory = await mkdtemp(join(tmpdir(), "ebb-run-owner-"));
    db = createSqliteDatabase(join(directory, "runs.sqlite"));
    runMigrations(db, loadTestMigrations());
    return db;
  }

  function insertRun(database: Database, runId: string, status = "STARTED", containmentKind: "systemd-user-service" | "windows-job" = "systemd-user-service"): void {
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','test-model',$status,'2026-10-01T00:00:00.000Z')",
      { id: runId, status },
    );
    database.transaction((tx) => insertRunProcessOwnerTx(tx, prepareRunProcessOwner(runId, join(directory, "hermes", runId), containmentKind)));
  }

  function insertLegacyRunWithoutOwner(database: Database | DatabaseTx, runId: string, status = "STARTED"): void {
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','test-model',$status,'2026-10-01T00:00:00.000Z')",
      { id: runId, status },
    );
  }

  function liveIdentity(runId: string): ProcessScopeIdentity {
    const row = db!.get<{ containment_id: string; launch_nonce: string }>(
      "SELECT containment_id,launch_nonce FROM run_process_owners WHERE run_id=$runId", { runId },
    )!;
    return {
      runId, containmentKind: "systemd-user-service", containmentId: row.containment_id,
      launchNonce: row.launch_nonce, systemdInvocationId: "11111111111111111111111111111111",
      systemdControlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/ebb-orchestrator-run-${row.containment_id}.service`,
      supervisorPid: null, supervisorStartIdentity: null, pid: 4321, platform: "linux",
      processStartIdentity: null, executableIdentity: null, state: "LAUNCHING",
    };
  }

  it("atomically inserts an exact source key and retains it across every owner transition and restart", async () => {
    const database = await setup();
    const owner = prepareRunProcessOwner("source-run", join(directory, "hermes", "source-run"), "systemd-user-service", snapshotKey);
    expect(owner.hermesSourceSnapshotKey).toBe(snapshotKey);
    expect(() => database.transaction((tx) => {
      insertLegacyRunWithoutOwner(tx, owner.runId);
      insertRunProcessOwnerTx(tx, owner);
      throw new Error("ROLLBACK_SOURCE_OWNER");
    })).toThrow("ROLLBACK_SOURCE_OWNER");
    expect(getRunProcessOwner(database, owner.runId)).toBeUndefined();
    expect(database.get("SELECT id FROM agent_runs WHERE id='source-run'")).toBeUndefined();
    database.transaction((tx) => {
      insertLegacyRunWithoutOwner(tx, owner.runId);
      insertRunProcessOwnerTx(tx, owner);
    });
    const identity = liveIdentity(owner.runId);
    const steps = [
      { expectedState: "PREPARED", nextState: "LAUNCHING" },
      { expectedState: "LAUNCHING", nextState: "LIVE", identity },
      { expectedState: "LIVE", nextState: "UNKNOWN", evidence: "OS_STATE_UNPROVEN" },
      { expectedState: "UNKNOWN", nextState: "LIVE", identity },
      { expectedState: "LIVE", nextState: "STOPPING" },
      { expectedState: "STOPPING", nextState: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" },
    ] as const;
    for (const step of steps) {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, { runId: owner.runId, ...step }));
      expect(getRunProcessOwner(database, owner.runId)?.hermesSourceSnapshotKey).toBe(snapshotKey);
    }
    database.close();
    db = createSqliteDatabase(join(directory, "runs.sqlite"));
    expect(runMigrations(db, loadTestMigrations()).applied).toBe(0);
    expect(getRunProcessOwner(db, owner.runId)).toMatchObject({ state: "STOPPED", hermesSourceSnapshotKey: snapshotKey });
  });

  it.each([
    "", "a".repeat(64), "null", "{}", ` ${snapshotKey}`,
    JSON.stringify({ ...snapshotIdentity, formatVersion: 2 }),
    JSON.stringify({ ...snapshotIdentity, manifestDigest: "A".repeat(64) }),
    JSON.stringify({ ...snapshotIdentity, sourceCommit: "b".repeat(39) }),
    JSON.stringify({ ...snapshotIdentity, sourceTree: "c".repeat(64) }),
    JSON.stringify({ ...snapshotIdentity, hermesVersion: "x".repeat(257) }),
    JSON.stringify({ ...snapshotIdentity, hermesVersion: "bad\nversion" }),
    JSON.stringify({ ...snapshotIdentity, hermesVersion: "\ud800" }),
    JSON.stringify({ ...snapshotIdentity, credential: "forbidden-extra-field" }),
    JSON.stringify({
      sourceTree: snapshotIdentity.sourceTree, formatVersion: 1, hermesVersion: snapshotIdentity.hermesVersion,
      manifestDigest: snapshotIdentity.manifestDigest, sourceCommit: snapshotIdentity.sourceCommit,
    }),
    snapshotKey.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'),
  ])("rejects a malformed supplied source key before preparation, insert and readback: %s", async (key) => {
    const database = await setup();
    expect(() => prepareRunProcessOwner("bad-source-run", "profile", "windows-job", key)).toThrow(TypeError);
    insertLegacyRunWithoutOwner(database, "bad-source-run");
    const owner = { ...prepareRunProcessOwner("bad-source-run", "profile", "windows-job"), hermesSourceSnapshotKey: key };
    expect(() => database.transaction((tx) => insertRunProcessOwnerTx(tx, owner))).toThrow(TypeError);
    expect(getRunProcessOwner(database, owner.runId)).toBeUndefined();
    database.transaction((tx) => insertRunProcessOwnerTx(tx, { ...owner, hermesSourceSnapshotKey: null }));
    database.run("UPDATE run_process_owners SET hermes_source_snapshot_key=$key WHERE run_id=$runId", { key, runId: owner.runId });
    expect(() => getRunProcessOwner(database, owner.runId)).toThrow("RUN_PROCESS_OWNER_INVALID");
  });

  it.each([undefined, null])("keeps historical source keys NULL without deriving a binding (%s)", async (key) => {
    const database = await setup();
    insertLegacyRunWithoutOwner(database, "legacy-source-run");
    const owner = prepareRunProcessOwner("legacy-source-run", "profile", "windows-job", key);
    database.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    expect(getRunProcessOwner(database, owner.runId)?.hermesSourceSnapshotKey).toBeNull();
    expect(database.get("SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='legacy-source-run'"))
      .toEqual({ hermes_source_snapshot_key: null });
  });

  it("accepts only the source identity version matching the process platform", async () => {
    const database = await setup();
    insertLegacyRunWithoutOwner(database, "windows-policy-run");
    const windowsOwner = prepareRunProcessOwner("windows-policy-run", "profile", "windows-job", windowsSnapshotKey);
    database.transaction((tx) => insertRunProcessOwnerTx(tx, windowsOwner));
    expect(getRunProcessOwner(database, "windows-policy-run")?.hermesSourceSnapshotKey).toBe(windowsSnapshotKey);

    insertLegacyRunWithoutOwner(database, "linux-legacy-run");
    const linuxOwner = prepareRunProcessOwner("linux-legacy-run", "profile-linux", "systemd-user-service", snapshotKey);
    database.transaction((tx) => insertRunProcessOwnerTx(tx, linuxOwner));
    expect(getRunProcessOwner(database, "linux-legacy-run")?.hermesSourceSnapshotKey).toBe(snapshotKey);

    expect(() => prepareRunProcessOwner("windows-v1-run", "profile-v1", "windows-job", snapshotKey)).toThrow(TypeError);
    expect(() => prepareRunProcessOwner("linux-v2-run", "profile-v2", "systemd-user-service", windowsSnapshotKey)).toThrow(TypeError);
  });

  it("reads and stops a legacy Windows v1 owner during recovery without allowing new v1 owners", async () => {
    const database = await setup();
    insertLegacyRunWithoutOwner(database, "legacy-windows-recovery", "COMPLETED");
    const owner = prepareRunProcessOwner("legacy-windows-recovery", "legacy-profile", "windows-job");
    database.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    database.run("UPDATE run_process_owners SET hermes_source_snapshot_key=$key WHERE run_id=$runId", {
      key: snapshotKey, runId: owner.runId,
    });
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: owner.runId, expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const identity: ProcessScopeIdentity = {
      runId: owner.runId,
      containmentKind: "windows-job",
      containmentId: owner.containmentId,
      launchNonce: owner.launchNonce,
      systemdInvocationId: null,
      systemdControlGroup: null,
      supervisorPid: 1234,
      supervisorStartIdentity: "supervisor-start",
      pid: 5678,
      platform: "win32",
      processStartIdentity: "process-start",
      executableIdentity: "executable-id",
      state: "LIVE",
    };
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: owner.runId, expectedState: "LAUNCHING", nextState: "LIVE", identity,
    }));
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "LIVE", identity }));
    const stop = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "WINDOWS_JOB_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect, stop,
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "WINDOWS_JOB_EMPTY" }),
    };

    expect(getRunProcessOwner(database, owner.runId)?.hermesSourceSnapshotKey).toBe(snapshotKey);
    await preflightRunProcessOwners(database, supervisor);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(database.get<{ state: string; stop_evidence: string; hermes_source_snapshot_key: string }>(
      "SELECT state,stop_evidence,hermes_source_snapshot_key FROM run_process_owners WHERE run_id=$runId",
      { runId: owner.runId },
    )).toEqual({ state: "STOPPED", stop_evidence: "WINDOWS_JOB_EMPTY", hermes_source_snapshot_key: snapshotKey });
    expect(() => prepareRunProcessOwner("new-windows-v1", "new-profile", "windows-job", snapshotKey)).toThrow(TypeError);
  });

  it("accepts canonical SHA-256 Git identity and preserves escaped and Unicode version bytes", async () => {
    const database = await setup();
    const key = JSON.stringify({
      ...snapshotIdentity, hermesVersion: 'fixture-версия-"quoted"-\\path',
      sourceCommit: "b".repeat(64), sourceTree: "c".repeat(64),
    });
    insertLegacyRunWithoutOwner(database, "sha256-source-run");
    database.transaction((tx) => insertRunProcessOwnerTx(tx,
      prepareRunProcessOwner("sha256-source-run", "profile", "systemd-user-service", key)));
    expect(getRunProcessOwner(database, "sha256-source-run")?.hermesSourceSnapshotKey).toBe(key);
  });

  it("enforces compare-and-set state transitions and keeps STOPPED terminal", async () => {
    const database = await setup();
    insertRun(database, "owner-run");
    const identity = liveIdentity("owner-run");

    expect(() => database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "PREPARED", nextState: "LIVE", identity,
    }))).toThrow(/TRANSITION_INVALID/);
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "LAUNCHING", nextState: "LIVE", identity,
    }));
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "LIVE", nextState: "STOPPING",
    }));
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "STOPPING", nextState: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY",
    }));

    expect(database.get<{ state: string; systemd_control_group: string; systemd_invocation_id: string }>(
      "SELECT state,systemd_control_group,systemd_invocation_id FROM run_process_owners WHERE run_id='owner-run'",
    )).toMatchObject({ state: "STOPPED", systemd_control_group: identity.systemdControlGroup, systemd_invocation_id: identity.systemdInvocationId });
    expect(() => database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "owner-run", expectedState: "STOPPED", nextState: "LAUNCHING",
    }))).toThrow(/TRANSITION_INVALID/);
  });

  it.each(["OS_STATE_UNPROVEN", "UNKNOWN_STOP_PROOF"])("does not persist %s as STOPPED evidence", async (evidence) => {
      const database = await setup();
      insertRun(database, "unproven-stop-run");
      expect(() => database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: "unproven-stop-run", expectedState: "PREPARED", nextState: "STOPPED", evidence,
      }))).toThrow(TypeError);
      expect(database.get<{ state: string; stop_evidence: string | null }>(
        "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='unproven-stop-run'",
      )).toEqual({ state: "PREPARED", stop_evidence: null });
    });

  it.each(["LIVE", "STOPPING", "UNKNOWN"] as const)("rejects no-launch proof from %s owners", async (state) => {
    const database = await setup();
    const runId = `forged-never-launched-${state.toLowerCase()}`;
    insertRun(database, runId);
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    if (state === "LIVE" || state === "STOPPING") {
      const identity = liveIdentity(runId);
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: "LAUNCHING", nextState: "LIVE", identity,
      }));
      if (state === "STOPPING") {
        database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId, expectedState: "LIVE", nextState: "STOPPING",
        }));
      }
    } else {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: "LAUNCHING", nextState: "UNKNOWN", evidence: "OS_STATE_UNPROVEN",
      }));
    }

    for (const evidence of ["NEVER_LAUNCHED", "LAUNCH_NOT_DISPATCHED"]) {
      expect(() => database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: state, nextState: "STOPPED", evidence,
      }))).toThrow(TypeError);
    }
    expect(getRunProcessOwner(database, runId)?.state).toBe(state);
  });

  it("does not allow the generic owner transition to persist launch-not-dispatched proof", async () => {
    const database = await setup();
    insertRun(database, "launch-not-dispatched-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "launch-not-dispatched-run", expectedState: "PREPARED", nextState: "LAUNCHING",
    }));

    expect(() => database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "launch-not-dispatched-run", expectedState: "LAUNCHING", nextState: "STOPPED",
      evidence: "LAUNCH_NOT_DISPATCHED",
    }))).toThrow(TypeError);
    expect(getRunProcessOwner(database, "launch-not-dispatched-run")?.state).toBe("LAUNCHING");
  });

  it("stops LIVE owners and only marks them STOPPED after supervisor proof", async () => {
    const database = await setup();
    insertRun(database, "live-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "live-run", expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const identity = liveIdentity("live-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "live-run", expectedState: "LAUNCHING", nextState: "LIVE", identity,
    }));
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "LIVE", identity: { ...identity, state: "LIVE" } }));
    const stop = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect, stop,
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }),
    };

    await preflightRunProcessOwners(database, supervisor);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: "live-run", state: "STOPPING" }));
    expect(database.get<{ state: string; stop_evidence: string }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='live-run'",
    )).toEqual({ state: "STOPPED", stop_evidence: "SYSTEMD_CGROUP_EMPTY" });
  });

  it("fails closed on UNKNOWN and converts PREPARED owners to proven never-launched STOPPED", async () => {
    const database = await setup();
    insertRun(database, "prepared-run");
    insertRun(database, "unknown-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "unknown-run", expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "UNKNOWN", reason: "ACCESS_DENIED" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect, stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "UNKNOWN", reason: "ACCESS_DENIED" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "UNKNOWN", reason: "ACCESS_DENIED" }),
    };

    await expect(preflightRunProcessOwners(database, supervisor)).rejects.toThrow("RUN_PROCESS_SCOPE_UNKNOWN:unknown-run");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='prepared-run'",
    )).toEqual({ state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" });
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='unknown-run'",
    )).toEqual({ state: "UNKNOWN", stop_evidence: "OS_STATE_UNPROVEN" });
  });

  it.each([
    "WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE",
    "WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE",
    "WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED",
    "WINDOWS_JOB_ACCOUNTING_UNAVAILABLE",
  ])("preserves only the exact Windows inspection reason %s for restart diagnostics", async (reason) => {
    const database = await setup();
    const runId = "run-id-must-not-reach-diagnostic";
    insertRun(database, runId, "STARTED", "windows-job");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const supervisor: ProcessScopeSupervisor = {
      inspect: async () => ({ state: "UNKNOWN", reason }),
      stop: async () => ({ state: "UNKNOWN", reason: "unused" }),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "UNKNOWN", reason: "unused" }),
    };

    let failure: unknown;
    try { await preflightRunProcessOwners(database, supervisor); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`RUN_PROCESS_SCOPE_UNKNOWN:${runId}`);
    expect(safeRestartChildFailureCode(failure)).toBe(reason);
    expect(safeRestartChildFailureCode(failure)).not.toContain(runId);
  });

  it.each([
    "WINDOWS_JOB_INSPECTION_UNAVAILABLE token=secret",
    "WINDOWS_JOB_INSPECTION_UNAVAILABLE:C:\\private\\path",
    "WINDOWS_UNRECOGNIZED_NATIVE_REASON",
  ])("does not forward an unrecognized Windows observation reason: %s", async (reason) => {
    const database = await setup();
    const runId = "run-id-must-not-reach-diagnostic";
    insertRun(database, runId, "STARTED", "windows-job");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const supervisor: ProcessScopeSupervisor = {
      inspect: async () => ({ state: "UNKNOWN", reason }),
      stop: async () => ({ state: "UNKNOWN", reason: "unused" }),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "UNKNOWN", reason: "unused" }),
    };

    let failure: unknown;
    try { await preflightRunProcessOwners(database, supervisor); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`RUN_PROCESS_SCOPE_UNKNOWN:${runId}`);
    expect((failure as Error).cause).toBeUndefined();
    expect(safeRestartChildFailureCode(failure)).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(reason);
  });

  it("recovers stale non-STOPPED owners attached to terminal Runs before startup continues", async () => {
    const database = await setup();
    insertRun(database, "terminal-stale-run", "COMPLETED");
    insertLegacyRunWithoutOwner(database, "terminal-legacy-run", "COMPLETED");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "terminal-stale-run", expectedState: "PREPARED", nextState: "LAUNCHING",
    }));
    const identity = liveIdentity("terminal-stale-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "terminal-stale-run", expectedState: "LAUNCHING", nextState: "LIVE", identity,
    }));
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "LIVE", identity: { ...identity, state: "LIVE" } }));
    const stop = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect, stop,
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }),
    };

    await preflightRunProcessOwners(database, supervisor);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ runId: "terminal-stale-run", state: "STOPPING" }));
    expect(database.get<{ status: string }>(
      "SELECT status FROM agent_runs WHERE id='terminal-stale-run'",
    )?.status).toBe("COMPLETED");
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='terminal-stale-run'",
    )).toEqual({ state: "STOPPED", stop_evidence: "SYSTEMD_CGROUP_EMPTY" });
    expect(database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_process_owners WHERE run_id='terminal-legacy-run'",
    )?.count).toBe(0);
  });

  it("fails closed on invalid STOPPED evidence attached to a terminal Run", async () => {
    const database = await setup();
    insertRun(database, "terminal-invalid-proof-run", "FAILED");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "terminal-invalid-proof-run", expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
    }));
    database.run("UPDATE run_process_owners SET stop_evidence='invalid evidence!' WHERE run_id='terminal-invalid-proof-run'");
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }),
    };

    await expect(preflightRunProcessOwners(database, supervisor))
      .rejects.toThrow("RUN_PROCESS_STOP_PROOF_INVALID:terminal-invalid-proof-run");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed before inspecting or changing owners when a nonterminal legacy Run has no owner row", async () => {
    const database = await setup();
    insertRun(database, "z-prepared-run");
    insertLegacyRunWithoutOwner(database, "a-ownerless-legacy-run");
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }),
    };

    await expect(preflightRunProcessOwners(database, supervisor))
      .rejects.toThrow("RUN_PROCESS_OWNER_MISSING:a-ownerless-legacy-run");

    expect(inspect).not.toHaveBeenCalled();
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='z-prepared-run'",
    )).toEqual({ state: "PREPARED", stop_evidence: null });
    expect(database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_process_owners WHERE run_id='a-ownerless-legacy-run'",
    )?.count).toBe(0);
  });

  it.each([
    { label: "NULL", evidence: null, expectedError: "MISSING" },
    { label: "blank", evidence: "", expectedError: "MISSING" },
    { label: "malformed nonblank token", evidence: "invalid evidence!", expectedError: "INVALID" },
    { label: "UNKNOWN marker", evidence: "OS_STATE_UNPROVEN", expectedError: "INVALID" },
    { label: "unknown bounded token", evidence: "UNKNOWN_STOP_PROOF", expectedError: "INVALID" },
  ])("fails closed before recovery side effects for $label STOPPED evidence", async ({ evidence, expectedError }) => {
    const database = await setup();
    insertRun(database, "z-stopped-unproven-run");
    database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: "z-stopped-unproven-run", expectedState: "PREPARED", nextState: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY",
    }));
    database.run(
      "UPDATE run_process_owners SET stop_evidence=$evidence WHERE run_id=$runId",
      { evidence, runId: "z-stopped-unproven-run" },
    );
    insertRun(database, "a-prepared-run");

    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" }),
    };

    await expect(preflightRunProcessOwners(database, supervisor))
      .rejects.toThrow(`RUN_PROCESS_STOP_PROOF_${expectedError}:z-stopped-unproven-run`);

    expect(inspect).not.toHaveBeenCalled();
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='a-prepared-run'",
    )).toEqual({ state: "PREPARED", stop_evidence: null });
    expect(database.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id='z-stopped-unproven-run'",
    )).toEqual({ state: "STOPPED", stop_evidence: evidence });
  });
});
