import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { insertRunProcessOwnerTx, prepareRunProcessOwner, preflightRunProcessOwners, transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeSupervisor } from "../../../src/platform/process/run-scope-supervisor.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

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

  function insertRun(database: Database, runId: string, status = "STARTED"): void {
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','test-model',$status,'2026-10-01T00:00:00.000Z')",
      { id: runId, status },
    );
    database.transaction((tx) => insertRunProcessOwnerTx(tx, prepareRunProcessOwner(runId, join(directory, "hermes", runId), "systemd-user-service")));
  }

  function insertLegacyRunWithoutOwner(database: Database, runId: string, status = "STARTED"): void {
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
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }),
    };

    await expect(preflightRunProcessOwners(database, supervisor))
      .rejects.toThrow("RUN_PROCESS_STOP_PROOF_INVALID:terminal-invalid-proof-run");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed before inspecting or changing owners when a nonterminal legacy Run has no owner row", async () => {
    const database = await setup();
    insertRun(database, "z-prepared-run");
    insertLegacyRunWithoutOwner(database, "a-ownerless-legacy-run");
    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }),
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

    const inspect = vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }));
    const supervisor: ProcessScopeSupervisor = {
      inspect,
      stop: vi.fn(async (): Promise<ProcessScopeObservation> => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" })),
      launch: async () => { throw new Error("not used"); },
      waitForStopped: async () => ({ state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" }),
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
