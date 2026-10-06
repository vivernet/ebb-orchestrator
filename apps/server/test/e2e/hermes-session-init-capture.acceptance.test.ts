import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { effectiveRunToolIds, RunService } from "../../src/modules/runtime/run-service.js";
import type { PreparedRunContext } from "../../src/modules/context/context-types.js";
import { digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import type { HermesSessionCapture, HermesSessionCapturePort } from "../../src/modules/runtime/hermes-session-capture-port.js";
import { HermesStreamSessionObserver } from "../../src/modules/runtime/hermes/hermes-stream-session-observer.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import type { Database } from "../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";

const encoder = new TextEncoder();
const UNALLOWLISTED_FIXTURE_FIELD_MARKER = "fixture-unallowlisted-field-marker";
let database: Database | undefined;
let directory = "";

class CaptureFixtureRuntime extends FakeAgentRuntime implements HermesSessionCapturePort {
  captureHandler: ((capture: HermesSessionCapture) => Promise<void>) | undefined;

  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void {
    this.captureHandler = handler;
  }
}

describe("Hermes init capture bridge — controlled protocol fixture only", () => {
  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("projects one fixture init ID and durably binds it to the exact LIVE SQLite owner", async () => {
    const fixture = await setup();
    const observer = new HermesStreamSessionObserver();
    const rawEvent = encoder.encode(`${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-fixture-001",
      text: UNALLOWLISTED_FIXTURE_FIELD_MARKER,
      provider: UNALLOWLISTED_FIXTURE_FIELD_MARKER,
    })}\n`);
    const observed = observer.push(rawEvent);

    expect(observed).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session-fixture-001" },
    });
    if (observed.status !== "captured" || !observed.projection || !fixture.runtime.captureHandler) {
      throw new Error("SESSION_CAPTURE_FIXTURE_SETUP_FAILED");
    }

    await fixture.runtime.captureHandler({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "captured",
      sessionId: observed.projection.sessionId,
    });

    expect(database!.get<{ session_id: string | null }>(
      "SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id },
    )).toEqual({ session_id: "session-fixture-001" });
    expect(database!.get<{ capture_state: string; state: string }>(
      "SELECT capture_state,state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id },
    )).toEqual({ capture_state: "BOUND", state: "LIVE" });
    // Ограничено allowlisted observer projection и явно выбранными SQLite-полями; проверка
    // не инспектирует логи, артефакты или остальные таблицы/поля базы данных.
    const selectedSafeColumns = database!.get(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    );
    expect(JSON.stringify({ observerProjection: observed, selectedSafeColumns }))
      .not.toContain(UNALLOWLISTED_FIXTURE_FIELD_MARKER);

    database!.close();
    database = createSqliteDatabase(join(directory, "capture.sqlite"));
    expect(database.get<{ session_id: string | null; capture_state: string; state: string }>(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: "session-fixture-001", capture_state: "BOUND", state: "LIVE" });
  });

  it("keeps duplicate-init protocol violations invalid and prevents a later fixture callback from rebinding", async () => {
    const fixture = await setup();
    const observer = new HermesStreamSessionObserver();
    const first = observer.push(encodeInit("session-fixture-002"));
    const duplicate = observer.push(encodeInit("session-fixture-003"));

    expect(first.status).toBe("captured");
    expect(duplicate).toEqual({ status: "invalid", reason: "DUPLICATE_INIT" });
    if (duplicate.status !== "invalid" || !fixture.runtime.captureHandler) {
      throw new Error("SESSION_CAPTURE_FIXTURE_SETUP_FAILED");
    }

    await fixture.runtime.captureHandler({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "invalid",
      reason: duplicate.reason,
    });
    await expect(fixture.runtime.captureHandler({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "captured",
      sessionId: "session-fixture-002",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALID");

    expect(database!.get<{ session_id: string | null; capture_state: string; state: string }>(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: null, capture_state: "INVALID", state: "LIVE" });
  });
});

async function setup() {
  directory = await mkdtemp(join(tmpdir(), "ebb-hermes-session-init-fixture-"));
  database = createSqliteDatabase(join(directory, "capture.sqlite"));
  runMigrations(database, loadTestMigrations());

  const now = new Date().toISOString();
  const projectId = randomUUID();
  const taskId = randomUUID();
  database.run(
    "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'capture-fixture','Capture Fixture','ACTIVE',$now,$now)",
    { id: projectId, now },
  );
  database.run(
    "INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'CAPTURE-FIXTURE','Capture fixture','READY','{}',1,$now,$now)",
    { id: taskId, projectId, now },
  );

  const runtime = new CaptureFixtureRuntime();
  const runService = new RunService(database, runtime, {
    prepare: (_tx, input) => ({
      finalPrompt: input.prompt,
      subject: { type: "TASK", id: taskId },
      role: "developer",
      contractDigest: null,
      items: [],
      contextBuilderVersion: "1.0.0",
      promptHash: digestRunPromptBytesV1(encoder.encode(input.prompt)),
      contextHash: createHash("sha256").update("fixture-context").digest("hex"),
      initialTokenSize: null,
      workspaceFingerprint: createHash("sha256").update("fixture-workspace").digest("hex"),
    } satisfies PreparedRunContext),
  });
  const run = runService.prepareRun({
    role: "developer",
    model: "fixture-model",
    taskId,
    epicId: null,
    triggerReason: "task-assignment",
    contextVersion: "mechanics-fixture-v1",
    outputSchemaVersion: "1",
    contextInput: {
      prompt: "Provider-free session capture mechanics fixture.",
      subject: { type: "TASK", id: taskId },
      role: "developer",
      roleInputs: {},
      versions: {
        roleVersion: null,
        runtime: "fixture",
        runtimeVersion: null,
        model: "fixture-model",
        modelVersion: null,
        outputSchemaVersion: "1",
        contextVersion: "mechanics-fixture-v1",
      },
      execution: {
        workspaceIdentity: { repository: "fixture-repo", workspace: "fixture-workspace", worktree: "fixture-worktree" },
        targetHead: null,
        targetBranch: null,
        effectiveCapabilityIds: effectiveRunToolIds("developer"),
        policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "fixture", runtimePolicyId: null },
      },
    },
  });

  const owner = database.get<{
    source_tag: string;
    hermes_home: string;
    containment_kind: "windows-job" | "systemd-user-service";
    containment_id: string;
    launch_nonce: string;
  }>(
    "SELECT source_tag,hermes_home,containment_kind,containment_id,launch_nonce FROM run_process_owners WHERE run_id=$runId",
    { runId: run.id },
  );
  if (!owner) throw new Error("SESSION_CAPTURE_FIXTURE_OWNER_MISSING");

  const identity: ProcessScopeIdentity = {
    runId: run.id,
    containmentKind: owner.containment_kind,
    containmentId: owner.containment_id,
    launchNonce: owner.launch_nonce,
    systemdInvocationId: process.platform === "linux" ? "12345678-1234-1234-1234-123456789abc" : null,
    systemdControlGroup: process.platform === "linux" ? `/user.slice/ebb-${owner.containment_id}.service` : null,
    supervisorPid: process.platform === "win32" ? 202 : null,
    supervisorStartIdentity: process.platform === "win32" ? "fixture-supervisor-start" : null,
    pid: 303,
    platform: process.platform,
    processStartIdentity: process.platform === "win32" ? "fixture-process-start" : null,
    executableIdentity: process.platform === "win32" ? `sha256:${"d".repeat(64)}` : null,
    state: "LIVE",
  };
  database.transaction((tx) => {
    transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
    transitionRunProcessOwnerTx(tx, {
      runId: run.id,
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
    });
  });

  return {
    identity,
    owner: { sourceTag: owner.source_tag, hermesHome: owner.hermes_home },
    run,
    runtime,
  };
}

function encodeInit(sessionId: string): Uint8Array {
  return encoder.encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
}
