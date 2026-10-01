#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { finished } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const serverEntrypoint = resolve(root, "apps/server/dist/main.js");
const readinessTimeoutMs = 90_000;
const shutdownTimeoutMs = 15_000;
const outputLimitBytes = 128 * 1024;
const pointerUpdateSql = "UPDATE project_config_state SET active_revision_id=$revisionId,config_status='READY',updated_at=$now WHERE project_id=$projectId AND current_candidate_id=$candidateId AND active_revision_id IS $expectedRevision";
const configText = (name, branch) => `schema_version: 1\nproject:\n  name: ${name}\n  default_branch: ${branch}\n`;

/** Запускает ограниченный production acceptance для Project Config durability и fail-closed recovery. */
async function runAcceptance() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-plan06-project-config-"));
  const passwordBytes = randomBytes(32);
  const password = passwordBytes.toString("base64url");
  let activeChild;
  let acceptanceError;
  let cleanupError;
  try {
    assertPathWithin(await realpath(tmpdir()), await realpath(temporaryRoot), "temporary root");
    if (process.platform === "win32") {
      await runWindowsFailClosedScenario(temporaryRoot, password, (child) => { activeChild = child; });
    } else {
      await runRestartScenario(temporaryRoot, password, (child) => { activeChild = child; });
      await runPreCommitCrashScenario(temporaryRoot, password, (child) => { activeChild = child; });
      await runPostCommitCrashScenario(temporaryRoot, password, (child) => { activeChild = child; });
      await runCorruptionScenario(temporaryRoot, password, (child) => { activeChild = child; });
    }
  } catch (error) {
    acceptanceError = error;
  } finally {
    passwordBytes.fill(0);
    try {
      await cleanupOwnedTemporaryRoot(activeChild, password, temporaryRoot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (acceptanceError) {
    if (cleanupError) console.error(`ACCEPTANCE_CLEANUP_SECONDARY_FAILURE=${safeErrorMessage(cleanupError, password)}`);
    throw acceptanceError;
  }
  if (cleanupError) throw cleanupError;
  if (process.platform === "win32") {
    console.log("PLAN06_PROJECT_CONFIG_RESTART_ACCEPTANCE=WAIVED / NOT RUN");
    console.log("Verified Windows production capture returns PROJECT_CONFIG_UNSUPPORTED_PLATFORM without persisting a candidate. Candidate lifecycle/restart acceptance requires POSIX safe file-handle verification and remains not run on Windows.");
  } else {
    console.log("PLAN06_PROJECT_CONFIG_RESTART_ACCEPTANCE=PASS");
    console.log("Verified: production dist/main.js persistence across restart, exact active revision/hash binding, approval transaction rollback at the active-pointer trigger and pre-COMMIT process kill/restart rollback with no project approval/outbox/audit side effects, post-COMMIT process kill before HTTP response and restart, corrupt and unsupported revision fail-closed, dispatch blocked, migration backup and cleanup. Host/power-loss crash recovery is not claimed.");
  }
}

async function runWindowsFailClosedScenario(temporaryRoot, password, onChild) {
  const scenarioRoot = join(temporaryRoot, "windows-fail-closed");
  const home = join(scenarioRoot, "home");
  const repository = join(scenarioRoot, "project");
  await mkdir(scenarioRoot);
  await mkdir(home);
  await createRepository(repository, "windows-capture-blocked", "main");
  const port = await reservePort();
  const server = await startProductionServer({ home, port, password, bootstrap: true }, onChild);
  const session = await login(server, password);
  const project = await createActiveOnboardedProject(session, repository);
  const unavailable = await requestJson(session, "POST", `/api/v1/projects/${project.projectId}/config/candidates`, {}, 503);
  assert.equal(unavailable.error, "PROJECT_CONFIG_UNSUPPORTED_PLATFORM");
  assert.match(unavailable.message, /Windows/i);

  const database = new DatabaseSync(server.databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_config_candidates WHERE project_id=?").get(project.projectId)?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_config_state WHERE project_id=?").get(project.projectId)?.count, 0);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    database.close();
  }
  await terminateAndRemoveStaleLock(server, password);
}

async function runRestartScenario(temporaryRoot, password, onChild) {
  const scenarioRoot = join(temporaryRoot, "active-pending-restart");
  const home = join(scenarioRoot, "home");
  const repository = join(scenarioRoot, "project");
  await mkdir(scenarioRoot);
  await mkdir(home);
  await createRepository(repository, "restart-sample", "main");
  const port = await reservePort();
  let server = await startProductionServer({ home, port, password, bootstrap: true }, onChild);
  let session = await login(server, password);
  const project = await createActiveOnboardedProject(session, repository);
  const initialCandidate = await captureCandidate(session, project.projectId);
  const initialRevision = await approveCandidate(session, project.projectId, initialCandidate);
  assertProjectBranch(initialRevision.normalizedConfig, "main", "initial approved revision");

  const workingConfigPath = join(repository, ".ebb-orchestrator", "project.yaml");
  await writeFile(workingConfigPath, configText("restart-sample", "develop"), "utf8");
  const expectedRepositoryStatus = git(repository, ["status", "--porcelain"]);
  assert.match(expectedRepositoryStatus, /\.ebb-orchestrator\/project\.yaml/);
  const pendingCandidate = await captureCandidate(session, project.projectId);
  assert.equal(pendingCandidate.status, "PENDING_REVIEW");
  assertProjectBranch(pendingCandidate.normalizedPreview, "develop", "pending candidate before restart");
  assert.equal(pendingCandidate.manifest.length > 0, true);
  let beforeRestart = await getProjectConfig(session, project.projectId);
  assert.equal(beforeRestart.active.revisionId, initialRevision.revisionId);
  assertProjectBranch(beforeRestart.active.normalizedConfig, "main", "active snapshot before restart");
  assert.equal(beforeRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(beforeRestart.current.manifestHash, pendingCandidate.manifestHash);

  const firstMigrationSnapshot = migrationSnapshot(server.databasePath);
  assert.ok(firstMigrationSnapshot.length > 0, "production startup did not apply migrations");
  await verifyMigrationBackup(home);
  await terminateAndRemoveStaleLock(server, password);
  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  assert.deepEqual(migrationSnapshot(server.databasePath), firstMigrationSnapshot, "process restart changed the applied migration set");

  const afterRestart = await getProjectConfig(session, project.projectId);
  assert.equal(afterRestart.degraded, false);
  assert.equal(afterRestart.active.revisionId, initialRevision.revisionId);
  assert.equal(afterRestart.active.revisionHash, initialRevision.revisionHash);
  assertProjectBranch(afterRestart.active.normalizedConfig, "main", "active snapshot after restart");
  assert.equal(afterRestart.current.status, "PENDING_REVIEW");
  assert.equal(afterRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterRestart.current.manifestHash, pendingCandidate.manifestHash);
  assertProjectBranch(afterRestart.current.normalizedPreview, "develop", "pending snapshot after restart");
  await verifyPreparedRunCapability({ scenarioRoot, repository, projectName: "restart-sample", expectedRepositoryStatus, server, session, project, active: afterRestart.active, pendingCandidate });

  const staleApproval = await requestJson(session, "POST", `/api/v1/projects/${project.projectId}/config/candidates/${pendingCandidate.candidateId}/approve`, { manifestHash: "0".repeat(64) }, 409);
  assert.equal(staleApproval.error, "PROJECT_CONFIG_CANDIDATE_NOT_CURRENT");

  await terminateAndRemoveStaleLock(server, password);
  await installActivePointerFailureTrigger(server.databasePath, server.home, project.projectId);
  const faultObserver = await createActivePointerFaultObserver(scenarioRoot, home, server.databasePath);
  server = await startProductionServer({ home, port, password, bootstrap: false, faultObserver }, onChild);
  session = await login(server, password);
  const revisionCountBeforeFault = (await getProjectConfig(session, project.projectId)).revisions.length;
  const approvalSideEffectsBeforeFault = projectApprovalSideEffectSnapshot(server.databasePath, project.projectId);
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 0);
  await assert.rejects(readFile(faultObserver.markerPath), { code: "ENOENT" }, "fault observer ran before the approval request");
  const faultResponse = await requestJson(
    session,
    "POST",
    `/api/v1/projects/${project.projectId}/config/candidates/${pendingCandidate.candidateId}/approve`,
    { manifestHash: pendingCandidate.manifestHash },
    503,
  );
  assert.equal(faultResponse.error, "Project Config is unavailable");
  assert.equal(await readFile(faultObserver.markerPath, "utf8"), faultObserver.markerContents, "production approval did not reach the exact active-pointer trigger error");
  assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), approvalSideEffectsBeforeFault, "failed approval left project-scoped approval, outbox, or audit rows");
  const afterFault = await getProjectConfig(session, project.projectId);
  assert.equal(afterFault.degraded, false);
  assert.equal(afterFault.active.revisionId, initialRevision.revisionId, "pre-commit failure changed the active pointer");
  assert.equal(afterFault.active.revisionHash, initialRevision.revisionHash);
  assertProjectBranch(afterFault.active.normalizedConfig, "main", "active snapshot after injected approval failure");
  assert.equal(afterFault.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterFault.current.status, "PENDING_REVIEW");
  assert.equal(afterFault.revisions.length, revisionCountBeforeFault, "failed transaction persisted a new revision");
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 0, "failed transaction persisted approval metadata");

  await terminateAndRemoveStaleLock(server, password);
  const faultDatabase = new DatabaseSync(server.databasePath);
  try {
    const state = faultDatabase.prepare("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=?").get(project.projectId);
    assert.equal(state.active_revision_id, initialRevision.revisionId);
    assert.equal(state.current_candidate_id, pendingCandidate.candidateId);
    assert.equal(faultDatabase.prepare("SELECT COUNT(*) AS count FROM project_config_revisions WHERE project_id=?").get(project.projectId).count, revisionCountBeforeFault);
    assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), approvalSideEffectsBeforeFault, "offline DB inspection found project approval side effects after rollback");
    assert.equal(faultDatabase.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='trg_plan06_fail_before_active_pointer_update'").get().count, 1);
    faultDatabase.exec("DROP TRIGGER trg_plan06_fail_before_active_pointer_update");
    assert.equal(faultDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(faultDatabase.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    faultDatabase.close();
  }
  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  const afterFaultRestart = await getProjectConfig(session, project.projectId);
  assert.equal(afterFaultRestart.degraded, false);
  assert.equal(afterFaultRestart.active.revisionId, initialRevision.revisionId, "restart recovered a non-active candidate after rollback");
  assert.equal(afterFaultRestart.active.revisionHash, initialRevision.revisionHash);
  assert.equal(afterFaultRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterFaultRestart.current.status, "PENDING_REVIEW");
  assert.equal(afterFaultRestart.revisions.length, revisionCountBeforeFault, "restart changed revision history after rollback");
  assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), approvalSideEffectsBeforeFault, "restart exposed rolled-back project approval, outbox, or audit rows");
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 0, "restart exposed a rolled-back approval");

  const activated = await approveCandidate(session, project.projectId, pendingCandidate);
  await terminateAndRemoveStaleLock(server, password);
  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  const afterCommitRestart = await getProjectConfig(session, project.projectId);
  assert.equal(afterCommitRestart.degraded, false);
  assert.equal(afterCommitRestart.active.revisionId, activated.revisionId);
  assert.equal(afterCommitRestart.active.revisionHash, activated.revisionHash);
  assertProjectBranch(afterCommitRestart.active.normalizedConfig, "develop", "exact new active revision after commit restart");
  assert.equal(afterCommitRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterCommitRestart.current.status, "APPROVED_ACTIVE");
  assert.equal(afterCommitRestart.revisions.length, revisionCountBeforeFault + 1, "committed approval did not persist exactly one new revision");
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 1, "committed approval metadata was not persisted exactly once");
  const committedApprovalId = revisionApprovalId(server.databasePath, project.projectId, activated.revisionId);
  assertProjectApprovalSideEffectDelta(approvalSideEffectsBeforeFault, projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), activated, pendingCandidate, project.projectId, committedApprovalId);
  assert.equal(activated.candidateId, pendingCandidate.candidateId);
  assert.equal(activated.manifestHash, pendingCandidate.manifestHash);
  assertProjectBranch(activated.normalizedConfig, "develop", "approved pending snapshot");
  assert.notEqual(activated.revisionHash, initialRevision.revisionHash);
  assert.equal(git(repository, ["status", "--porcelain"]), expectedRepositoryStatus, "restart or approval applied repository content");
  await terminateProductionProcess(server, password);
}

async function runPreCommitCrashScenario(temporaryRoot, password, onChild) {
  const scenarioRoot = join(temporaryRoot, "pre-commit-process-kill");
  const home = join(scenarioRoot, "home");
  const repository = join(scenarioRoot, "project");
  await mkdir(scenarioRoot);
  await mkdir(home);
  await createRepository(repository, "pre-commit-sample", "main");

  const port = await reservePort();
  let server = await startProductionServer({ home, port, password, bootstrap: true }, onChild);
  let session = await login(server, password);
  const project = await createActiveOnboardedProject(session, repository);
  const initialCandidate = await captureCandidate(session, project.projectId);
  const initialRevision = await approveCandidate(session, project.projectId, initialCandidate);
  await writeFile(join(repository, ".ebb-orchestrator", "project.yaml"), configText("pre-commit-sample", "develop"), "utf8");
  const expectedRepositoryStatus = git(repository, ["status", "--porcelain"]);
  assert.match(expectedRepositoryStatus, /\.ebb-orchestrator\/project\.yaml/);

  const pendingCandidate = await captureCandidate(session, project.projectId);
  const beforeCrash = await getProjectConfig(session, project.projectId);
  assert.equal(beforeCrash.active.revisionId, initialRevision.revisionId);
  assert.equal(beforeCrash.active.revisionHash, initialRevision.revisionHash);
  assert.equal(beforeCrash.current.candidateId, pendingCandidate.candidateId);
  assert.equal(beforeCrash.current.status, "PENDING_REVIEW");
  assertProjectBranch(pendingCandidate.normalizedPreview, "develop", "pending candidate before pre-COMMIT crash");
  const revisionCountBeforeCrash = beforeCrash.revisions.length;
  const sideEffectsBeforePreCommitCrash = projectApprovalSideEffectSnapshot(server.databasePath, project.projectId);

  await terminateAndRemoveStaleLock(server, password);
  const preCommitObserver = await createPreCommitCrashObserver(
    scenarioRoot,
    home,
    server.databasePath,
    project.projectId,
    pendingCandidate,
    initialRevision.revisionId,
  );
  server = await startProductionServer({ home, port, password, bootstrap: false, preCommitObserver }, onChild);
  session = await login(server, password);
  const beforeApproval = await getProjectConfig(session, project.projectId);
  assert.equal(beforeApproval.active.revisionId, initialRevision.revisionId);
  assert.equal(beforeApproval.current.candidateId, pendingCandidate.candidateId);
  assert.equal(beforeApproval.current.status, "PENDING_REVIEW");
  assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), sideEffectsBeforePreCommitCrash);
  await assert.rejects(readFile(preCommitObserver.markerPath), { code: "ENOENT" }, "pre-COMMIT observer ran before the approval request");

  const preCommitApprovalPromise = beginApprovalRequest(session, project.projectId, pendingCandidate);
  const preCommitEvidence = await waitForPreCommitObserver(server.child, preCommitObserver);
  await terminateAndRemoveStaleLock(server, password);
  const preCommitApprovalOutcome = await preCommitApprovalPromise;
  assert.equal(preCommitApprovalOutcome.kind, "transport-error", "server returned an HTTP response before the uncommitted process was killed");

  assert.equal(preCommitEvidence.event, "PLAN06_PRE_COMMIT_ACTIVE_POINTER");
  assert.equal(preCommitEvidence.projectId, project.projectId);
  assert.equal(preCommitEvidence.candidateId, pendingCandidate.candidateId);
  assert.equal(preCommitEvidence.previousRevisionId, initialRevision.revisionId);
  assert.equal(preCommitEvidence.manifestHash, pendingCandidate.manifestHash);
  assert.equal(preCommitEvidence.transactionOpen, true, "active-pointer UPDATE was not held inside an open SQLite transaction");
  assert.notEqual(preCommitEvidence.activeRevisionId, initialRevision.revisionId);
  assert.match(preCommitEvidence.revisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(preCommitEvidence.revisionHash, /^[0-9a-f]{64}$/);
  assert.match(preCommitEvidence.approvalId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  const afterPreCommitRestart = await getProjectConfig(session, project.projectId);
  assert.equal(afterPreCommitRestart.degraded, false);
  assert.equal(afterPreCommitRestart.active.revisionId, initialRevision.revisionId);
  assert.equal(afterPreCommitRestart.active.revisionHash, initialRevision.revisionHash);
  assertProjectBranch(afterPreCommitRestart.active.normalizedConfig, "main", "old active revision after pre-COMMIT process restart");
  assert.equal(afterPreCommitRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterPreCommitRestart.current.status, "PENDING_REVIEW");
  assert.equal(afterPreCommitRestart.current.manifestHash, pendingCandidate.manifestHash);
  assert.equal(afterPreCommitRestart.revisions.length, revisionCountBeforeCrash);
  assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), sideEffectsBeforePreCommitCrash, "production restart exposed uncommitted approval, outbox, or audit rows");
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 0, "production restart exposed uncommitted approval metadata");
  const database = new DatabaseSync(server.databasePath, { readOnly: true });
  try {
    const state = database.prepare("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=?").get(project.projectId);
    assert.equal(state?.current_candidate_id, pendingCandidate.candidateId);
    assert.equal(state?.active_revision_id, initialRevision.revisionId, "production restart retained an uncommitted active pointer");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_config_revisions WHERE project_id=?").get(project.projectId).count, revisionCountBeforeCrash, "production restart retained an uncommitted revision");
    assert.equal(database.prepare("SELECT status FROM project_config_candidates WHERE project_id=? AND candidate_id=?").get(project.projectId, pendingCandidate.candidateId)?.status, "PENDING_REVIEW");
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
  assert.equal(git(repository, ["status", "--porcelain"]), expectedRepositoryStatus, "pre-COMMIT restart applied repository content");
  await terminateProductionProcess(server, password);
}

async function runPostCommitCrashScenario(temporaryRoot, password, onChild) {
  const scenarioRoot = join(temporaryRoot, "post-commit-process-kill");
  const home = join(scenarioRoot, "home");
  const repository = join(scenarioRoot, "project");
  await mkdir(scenarioRoot);
  await mkdir(home);
  await createRepository(repository, "post-commit-sample", "main");

  const port = await reservePort();
  let server = await startProductionServer({ home, port, password, bootstrap: true }, onChild);
  let session = await login(server, password);
  const project = await createActiveOnboardedProject(session, repository);
  const initialCandidate = await captureCandidate(session, project.projectId);
  const initialRevision = await approveCandidate(session, project.projectId, initialCandidate);
  await writeFile(join(repository, ".ebb-orchestrator", "project.yaml"), configText("post-commit-sample", "develop"), "utf8");
  const expectedRepositoryStatus = git(repository, ["status", "--porcelain"]);
  assert.match(expectedRepositoryStatus, /\.ebb-orchestrator\/project\.yaml/);

  const pendingCandidate = await captureCandidate(session, project.projectId);
  const beforeCrash = await getProjectConfig(session, project.projectId);
  assert.equal(beforeCrash.active.revisionId, initialRevision.revisionId);
  assert.equal(beforeCrash.active.revisionHash, initialRevision.revisionHash);
  assert.equal(beforeCrash.current.candidateId, pendingCandidate.candidateId);
  assert.equal(beforeCrash.current.status, "PENDING_REVIEW");
  assertProjectBranch(pendingCandidate.normalizedPreview, "develop", "pending candidate before post-commit crash");
  const revisionCountBeforeCrash = beforeCrash.revisions.length;
  const sideEffectsBeforeCrash = projectApprovalSideEffectSnapshot(server.databasePath, project.projectId);

  await terminateAndRemoveStaleLock(server, password);
  const commitObserver = await createPostCommitCrashObserver(
    scenarioRoot,
    home,
    server.databasePath,
    project.projectId,
    pendingCandidate,
    initialRevision.revisionId,
  );
  server = await startProductionServer({ home, port, password, bootstrap: false, commitObserver }, onChild);
  session = await login(server, password);
  const beforeApproval = await getProjectConfig(session, project.projectId);
  assert.equal(beforeApproval.active.revisionId, initialRevision.revisionId);
  assert.equal(beforeApproval.current.candidateId, pendingCandidate.candidateId);
  assert.equal(beforeApproval.current.status, "PENDING_REVIEW");
  assert.deepEqual(projectApprovalSideEffectSnapshot(server.databasePath, project.projectId), sideEffectsBeforeCrash);
  await assert.rejects(readFile(commitObserver.markerPath), { code: "ENOENT" }, "post-commit observer fired before approval");

  const crashApprovalPromise = beginApprovalRequest(session, project.projectId, pendingCandidate);
  const commitEvidence = await waitForPostCommitObserver(server.child, commitObserver);
  assert.equal(commitEvidence.event, "PLAN06_POST_COMMIT_ACTIVE_POINTER");
  assert.equal(commitEvidence.projectId, project.projectId);
  assert.equal(commitEvidence.candidateId, pendingCandidate.candidateId);
  assert.equal(commitEvidence.previousRevisionId, initialRevision.revisionId);
  assert.equal(commitEvidence.manifestHash, pendingCandidate.manifestHash);
  assert.match(commitEvidence.revisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(commitEvidence.revisionHash, /^[0-9a-f]{64}$/);
  assert.match(commitEvidence.approvalId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  await terminateAndRemoveStaleLock(server, password);
  const crashApprovalOutcome = await crashApprovalPromise;
  assert.equal(crashApprovalOutcome.kind, "transport-error", "server returned an HTTP response instead of being killed after commit");

  const committedApproval = { revisionId: commitEvidence.revisionId, revisionHash: commitEvidence.revisionHash };
  const sideEffectsAfterCrash = projectApprovalSideEffectSnapshot(server.databasePath, project.projectId);
  assertProjectApprovalSideEffectDelta(sideEffectsBeforeCrash, sideEffectsAfterCrash, committedApproval, pendingCandidate, project.projectId, commitEvidence.approvalId);
  assert.equal(approvalMetadataCount(server.databasePath, pendingCandidate.candidateId), 1);

  const database = new DatabaseSync(server.databasePath, { readOnly: true });
  try {
    const state = database.prepare("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=?").get(project.projectId);
    assert.equal(state?.current_candidate_id, pendingCandidate.candidateId);
    assert.equal(state?.active_revision_id, commitEvidence.revisionId);
    const revision = database.prepare("SELECT candidate_id,manifest_hash,revision_hash,approval_id FROM project_config_revisions WHERE project_id=? AND revision_id=?").get(project.projectId, commitEvidence.revisionId);
    assert.equal(revision?.candidate_id, pendingCandidate.candidateId);
    assert.equal(revision?.manifest_hash, pendingCandidate.manifestHash);
    assert.equal(revision?.revision_hash, commitEvidence.revisionHash);
    assert.equal(revision?.approval_id, commitEvidence.approvalId);
    assert.equal(database.prepare("SELECT status FROM project_config_candidates WHERE project_id=? AND candidate_id=?").get(project.projectId, pendingCandidate.candidateId)?.status, "APPROVED_ACTIVE");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_config_revisions WHERE project_id=?").get(project.projectId).count, revisionCountBeforeCrash + 1);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }

  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  const afterCrashRestart = await getProjectConfig(session, project.projectId);
  assert.equal(afterCrashRestart.degraded, false);
  assert.equal(afterCrashRestart.active.revisionId, commitEvidence.revisionId);
  assert.equal(afterCrashRestart.active.revisionHash, commitEvidence.revisionHash);
  assertProjectBranch(afterCrashRestart.active.normalizedConfig, "develop", "new active revision after post-commit process restart");
  assert.equal(afterCrashRestart.current.candidateId, pendingCandidate.candidateId);
  assert.equal(afterCrashRestart.current.status, "APPROVED_ACTIVE");
  assert.equal(afterCrashRestart.current.manifestHash, pendingCandidate.manifestHash);
  assert.equal(afterCrashRestart.revisions.length, revisionCountBeforeCrash + 1);
  const sideEffectsAfterRestart = projectApprovalSideEffectSnapshot(server.databasePath, project.projectId);
  assert.deepEqual(sideEffectsAfterRestart, sideEffectsAfterCrash, "restart duplicated or removed committed approval side effects");
  assertProjectApprovalSideEffectDelta(sideEffectsBeforeCrash, sideEffectsAfterRestart, committedApproval, pendingCandidate, project.projectId, commitEvidence.approvalId);
  assert.equal(git(repository, ["status", "--porcelain"]), expectedRepositoryStatus, "post-commit restart applied repository content");
  await terminateProductionProcess(server, password);
}

async function runCorruptionScenario(temporaryRoot, password, onChild) {
  const scenarioRoot = join(temporaryRoot, "corrupt-revisions");
  const home = join(scenarioRoot, "home");
  await mkdir(scenarioRoot);
  await mkdir(home);
  const port = await reservePort();
  let server = await startProductionServer({ home, port, password, bootstrap: true }, onChild);
  let session = await login(server, password);
  const corrupt = await prepareThreeRevisionProject(session, join(scenarioRoot, "corrupt-project"), "corrupt-sample");
  const unsupported = await prepareThreeRevisionProject(session, join(scenarioRoot, "unsupported-project"), "unsupported-sample");
  await terminateAndRemoveStaleLock(server, password);

  const databasePath = server.databasePath;
  assertPathWithin(await realpath(home), await realpath(databasePath), "disposable database");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("DROP TRIGGER trg_project_config_revision_immutable");
    database.prepare("UPDATE project_config_revisions SET normalized_payload_json='{}' WHERE revision_id=?").run(corrupt.activeRevision.revisionId);
    database.prepare("UPDATE project_config_revisions SET schema_version=999 WHERE revision_id=?").run(unsupported.activeRevision.revisionId);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }

  server = await startProductionServer({ home, port, password, bootstrap: false }, onChild);
  session = await login(server, password);
  for (const item of [corrupt, unsupported]) {
    const state = await getProjectConfig(session, item.project.projectId);
    assert.equal(state.degraded, true, "invalid active revision did not degrade its Project");
    assert.equal(state.active, null, "invalid active revision was returned as runtime authority");
    assert.equal(state.current.candidateId, item.pendingCandidate.candidateId);
    assert.equal(state.current.status, "PENDING_REVIEW");
    assert.equal(state.current.manifestHash, item.pendingCandidate.manifestHash);
    assertProjectBranch(state.current.normalizedPreview, "feature", "pending snapshot after corruption restart");
    assert.ok(state.revisions.some((revision) => revision.revisionId === item.olderRevision.revisionId), "valid history was not retained for explicit recovery");
    assert.ok(!state.revisions.some((revision) => revision.revisionId === item.activeRevision.revisionId), "invalid revision was returned as a valid historical snapshot");

    const taskResponse = await requestJson(session, "POST", `/api/v1/projects/${item.project.projectId}/tasks`, {
      version: 1,
      goal: "Project Config dispatch guard acceptance",
      context: "Disposable acceptance fixture",
      requirements: [],
      acceptanceCriteria: [],
      dependencies: [],
      nonGoals: [],
      definitionOfDone: [],
    }, 201);
    const taskId = taskResponse.task.id;
    const update = new DatabaseSync(databasePath);
    try {
      update.prepare("UPDATE tasks SET status='READY' WHERE id=?").run(taskId);
    } finally {
      update.close();
    }
    const dispatch = await requestJson(session, "POST", `/api/v1/tasks/${taskId}/dispatch`, {}, 409);
    assert.equal(dispatch.error.code, "PROJECT_CONFIG_DEGRADED", "dispatch did not fail closed on invalid active config");
    const runCount = countTaskRuns(databasePath, taskId);
    assert.equal(runCount, 0, "dispatch created an Agent Run for a degraded Project");
  }
  await terminateProductionProcess(server, password);
}

async function verifyPreparedRunCapability({ scenarioRoot, repository, projectName, expectedRepositoryStatus, server, session, project, active, pendingCandidate }) {
  const taskResponse = await requestJson(session, "POST", `/api/v1/projects/${project.projectId}/tasks`, {
    version: 1,
    goal: "Project Config RunCapability binding acceptance",
    context: "Disposable acceptance fixture",
    requirements: [],
    acceptanceCriteria: [],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: [],
  }, 201);
  const taskId = taskResponse.task.id;
  assert.equal(typeof taskId, "string");
  const branch = `task/${taskId}`;
  const workspace = join(scenarioRoot, "capability-worktree");
  git(repository, ["worktree", "add", "-b", branch, workspace, "HEAD"]);
  assertPathWithin(await realpath(scenarioRoot), await realpath(workspace), "capability workspace");
  const worktreeConfigPath = join(workspace, ".ebb-orchestrator", "project.yaml");
  await writeFile(worktreeConfigPath, configText(projectName, "develop"), "utf8");
  const rawWorktreeConfig = await readFile(worktreeConfigPath, "utf8");
  assert.match(rawWorktreeConfig, /default_branch: develop/);

  const [{ createSqliteDatabase }, { BackupService }, { RunService }, { loadValidatedCapability }] = await Promise.all([
    import(pathToFileURL(resolve(root, "apps/server/dist/platform/database/sqlite-database.js")).href),
    import(pathToFileURL(resolve(root, "apps/server/dist/platform/database/backup-service.js")).href),
    import(pathToFileURL(resolve(root, "apps/server/dist/modules/runtime/run-service.js")).href),
    import(pathToFileURL(resolve(root, "apps/server/dist/modules/execution/capability-validation.js")).href),
  ]);

  const snapshotDirectory = join(scenarioRoot, "capability-database-snapshot");
  const sourceDatabase = createSqliteDatabase(server.databasePath);
  let snapshot;
  try {
    snapshot = new BackupService(sourceDatabase).createBackup(snapshotDirectory);
  } finally {
    sourceDatabase.close();
  }
  assertPathWithin(await realpath(scenarioRoot), await realpath(snapshot.path), "production database snapshot");

  const snapshotDatabase = createSqliteDatabase(snapshot.path);
  let runtimeCalls = 0;
  try {
    const state = snapshotDatabase.get("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=$id", { id: project.projectId });
    assert.equal(state.current_candidate_id, pendingCandidate.candidateId);
    assert.equal(state.active_revision_id, active.revisionId);
    snapshotDatabase.run("UPDATE tasks SET status='READY' WHERE id=$id", { id: taskId });
    snapshotDatabase.run(
      "INSERT INTO worktrees(id,repo_path,path,branch,created_at,removed_at) VALUES($id,$repo,$path,$branch,$created,NULL)",
      { id: taskId, repo: repository, path: workspace, branch, created: new Date().toISOString() },
    );

    const runtimeStub = {
      startRun() { runtimeCalls += 1; throw new Error("provider/runtime invocation is forbidden in capability acceptance"); },
      collectResult() { runtimeCalls += 1; throw new Error("provider/runtime invocation is forbidden in capability acceptance"); },
    };
    const runService = new RunService(snapshotDatabase, runtimeStub);
    const run = runService.prepareRun({
      role: "developer",
      model: "plan06-acceptance-no-provider",
      taskId,
      epicId: null,
      triggerReason: "task-assignment",
      contextVersion: "plan06-project-config-restart-acceptance",
      outputSchemaVersion: "1",
      capability: { workspace },
    });
    const persisted = snapshotDatabase.get("SELECT capability_json FROM agent_runs WHERE id=$id", { id: run.id });
    assert.ok(persisted?.capability_json, "RunService did not persist its prepared capability");
    const persistedCapability = JSON.parse(persisted.capability_json);
    assert.equal(persistedCapability.approvedProjectConfig.revisionId, active.revisionId);
    assert.equal(persistedCapability.approvedProjectConfig.revisionHash, active.revisionHash);
    assert.equal(persistedCapability.approvedProjectConfig.config.project.default_branch, "main");

    const capability = loadValidatedCapability(snapshotDatabase, run.capabilityRef);
    const approved = capability.capability.approvedProjectConfig;
    assert.ok(approved, "validated RunCapability omitted the approved Project Config snapshot");
    assert.equal(approved.revisionId, active.revisionId);
    assert.equal(approved.revisionHash, active.revisionHash);
    assert.equal(approved.config.project.default_branch, "main");
    assertProjectBranch(pendingCandidate.normalizedPreview, "develop", "pending candidate during capability issuance");
    assert.notEqual(approved.config.project.default_branch, pendingCandidate.normalizedPreview.project.project.default_branch);
    const approvedFile = await capability.getActionGateway().readFile(".ebb-orchestrator/project.yaml");
    assert.equal(approvedFile.success, true);
    assert.match(approvedFile.content, /default_branch: main/);
    assert.doesNotMatch(approvedFile.content, /default_branch: develop/);
    assert.equal(runtimeCalls, 0, "capability preparation invoked runtime/provider code");
  } finally {
    snapshotDatabase.close();
  }
  assert.equal(git(repository, ["status", "--porcelain"]), expectedRepositoryStatus, "capability fixture changed the project repository");
}

async function prepareThreeRevisionProject(session, repository, name) {
  await createRepository(repository, name, "main");
  const project = await createActiveOnboardedProject(session, repository);
  const firstCandidate = await captureCandidate(session, project.projectId);
  const olderRevision = await approveCandidate(session, project.projectId, firstCandidate);
  await writeFile(join(repository, ".ebb-orchestrator", "project.yaml"), configText(name, "develop"), "utf8");
  const activeCandidate = await captureCandidate(session, project.projectId);
  const activeRevision = await approveCandidate(session, project.projectId, activeCandidate);
  await writeFile(join(repository, ".ebb-orchestrator", "project.yaml"), configText(name, "feature"), "utf8");
  const pendingCandidate = await captureCandidate(session, project.projectId);
  return { project, olderRevision, activeRevision, pendingCandidate };
}

async function createActiveOnboardedProject(session, repository) {
  const discovered = await requestJson(session, "POST", "/api/v1/onboarding/discover", { repositoryPath: repository }, 201);
  const projectId = discovered.projectId;
  assert.equal(typeof projectId, "string");
  const proposal = { defaultBranch: "main", workflow: "local-default", roles: [], guidelines: [] };
  await requestJson(session, "POST", `/api/v1/onboarding/${projectId}/approval`, { proposed: proposal }, 201);
  await requestJson(session, "POST", `/api/v1/onboarding/${projectId}/approve`, {}, 200);
  await requestJson(session, "POST", `/api/v1/onboarding/${projectId}/activate`, {}, 200);
  return { projectId };
}

async function captureCandidate(session, projectId) {
  const response = await requestJson(session, "POST", `/api/v1/projects/${projectId}/config/candidates`, {}, 201);
  assert.equal(typeof response.candidate.candidateId, "string");
  assert.match(response.candidate.manifestHash, /^[a-f0-9]{64}$/);
  return response.candidate;
}

async function approveCandidate(session, projectId, candidate) {
  const response = await requestJson(
    session,
    "POST",
    `/api/v1/projects/${projectId}/config/candidates/${candidate.candidateId}/approve`,
    { manifestHash: candidate.manifestHash },
    200,
  );
  assert.equal(response.active.candidateId, candidate.candidateId);
  assert.equal(response.active.manifestHash, candidate.manifestHash);
  return response.active;
}

async function getProjectConfig(session, projectId) {
  return requestJson(session, "GET", `/api/v1/projects/${projectId}/config`, undefined, 200);
}

async function requestJson(session, method, path, body, expectedStatus) {
  const mutating = method !== "GET" && method !== "HEAD";
  const headers = { cookie: session.cookie };
  if (mutating) {
    headers.origin = session.origin;
    headers["x-csrf-token"] = session.csrfToken;
    headers["content-type"] = "application/json";
  }
  const response = await globalThis.fetch(`${session.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${method} ${path} returned HTTP ${response.status}`);
  return payload;
}

function beginApprovalRequest(session, projectId, candidate) {
  return globalThis.fetch(`${session.origin}/api/v1/projects/${projectId}/config/candidates/${candidate.candidateId}/approve`, {
    method: "POST",
    headers: {
      cookie: session.cookie,
      origin: session.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ manifestHash: candidate.manifestHash }),
    signal: globalThis.AbortSignal.timeout(30_000),
  }).then(
    async (response) => ({ kind: "http-response", status: response.status, payload: await response.json().catch(() => null) }),
    (error) => ({ kind: "transport-error", message: error instanceof Error ? error.message : "unknown transport error" }),
  );
}

async function login(server, password) {
  const response = await globalThis.fetch(`${server.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { origin: server.origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, "production local-session login failed");
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "production login did not issue its local session cookie");
  assert.match(payload?.csrfToken ?? "", /^[A-Za-z0-9_-]{43}$/);
  return { origin: server.origin, cookie: setCookie.split(";", 1)[0], csrfToken: payload.csrfToken };
}

async function startProductionServer({ home, port, password, bootstrap, faultObserver, preCommitObserver, commitObserver }, onChild) {
  assertPathWithin(await realpath(tmpdir()), await realpath(home), "disposable home");
  assert.equal([faultObserver, preCommitObserver, commitObserver].filter(Boolean).length <= 1, true, "only one test observer may be installed in a production child");
  const observer = faultObserver ?? preCommitObserver ?? commitObserver;
  const args = [
    ...(observer ? ["--import", pathToFileURL(observer.preloadPath).href] : []),
    serverEntrypoint,
    ...(bootstrap ? ["--bootstrap-local-user-stdin"] : []),
  ];
  const env = { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: String(port) };
  for (const key of Object.keys(env)) {
    if (key.startsWith("EBB_HERMES_")) delete env[key];
  }
  delete env.PLAN06_FAULT_OBSERVER_DATABASE;
  delete env.PLAN06_FAULT_OBSERVER_MARKER;
  if (observer) {
    assertPathWithin(await realpath(tmpdir()), await realpath(observer.root), "test observer root");
    assertPathWithin(await realpath(observer.root), await realpath(observer.preloadPath), "test observer preload");
    assertPathWithin(await realpath(observer.root), await realpath(observer.markerDirectory), "test observer marker directory");
  }
  if (faultObserver) {
    env.PLAN06_FAULT_OBSERVER_DATABASE = faultObserver.databasePath;
    env.PLAN06_FAULT_OBSERVER_MARKER = faultObserver.markerPath;
  }
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    shell: false,
    stdio: [bootstrap ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const output = captureOutput(child, password);
  child.outputCapture = output;
  const server = { child, output, origin: `http://127.0.0.1:${port}`, home, databasePath: join(home, "ebb-orchestrator.db"), password };
  onChild(child);
  if (bootstrap) await writeBootstrapPassword(child, password);
  await waitForReady(server);
  assert.equal(output.secretLeak, false, "local-user secret appeared in production child output");
  return server;
}

function captureOutput(child, secret) {
  const output = { stdout: "", stderr: "", overflow: false, secretLeak: false };
  const tails = { stdout: "", stderr: "" };
  const append = (stream, chunk) => {
    const text = String(chunk);
    const combined = tails[stream] + text;
    if (combined.includes(secret)) output.secretLeak = true;
    tails[stream] = combined.slice(-Math.max(0, secret.length - 1));
    if (Buffer.byteLength(output[stream] + text, "utf8") > outputLimitBytes) {
      output.overflow = true;
      return;
    }
    output[stream] += text;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  return output;
}

async function writeBootstrapPassword(child, password) {
  const payload = Buffer.from(`${password}\n${password}\n`, "utf8");
  const completion = finished(child.stdin, { cleanup: true, readable: false });
  try {
    child.stdin.end(payload);
    await completion;
  } finally {
    payload.fill(0);
  }
}

async function waitForReady(server) {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const { child, output } = server;
    if (child.exitCode !== null || child.signalCode !== null) {
      const startupOutput = output.secretLeak
        ? "[startup output omitted because it contained the local-user secret]"
        : `${output.stderr}\n${output.stdout}`.trim().replaceAll(server.password, "[REDACTED]").slice(-1200);
      throw new Error(`production dist/main.js exited before READY (code=${child.exitCode}, signal=${child.signalCode}); sanitized output=${JSON.stringify(startupOutput)}`);
    }
    const response = await globalThis.fetch(`${server.origin}/api/v1/health`, { signal: globalThis.AbortSignal.timeout(500) }).catch(() => undefined);
    if (response?.ok) {
      const health = await response.json();
      assert.equal(health.lifecycle, "READY");
      assert.match(output.stdout, /status: READY/);
      assert.equal(output.overflow, false, "production child output exceeded the bounded capture limit");
      return;
    }
    await delay(100);
  }
  throw new Error("production server did not reach READY within the bounded timeout");
}

async function waitForPostCommitObserver(child, observer) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(observer.markerPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`production process exited before the post-COMMIT marker (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    await delay(25);
  }
  throw new Error("production approval did not reach the post-COMMIT observer within the bounded timeout");
}

async function waitForPreCommitObserver(child, observer) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(observer.markerPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`production process exited before the pre-COMMIT marker (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    await delay(25);
  }
  throw new Error("production approval did not reach the pre-COMMIT observer within the bounded timeout");
}

async function terminateAndRemoveStaleLock(server, password) {
  await terminateProductionProcess(server, password);
  const lockPath = join(server.home, "orchestrator.lock");
  const lockRecord = await readFile(lockPath, "utf8");
  const match = /^v1:(\d+):[a-f0-9]{32}\r?\n$/.exec(lockRecord);
  assert.ok(match, "terminated production process left an invalid lock record");
  assert.equal(Number(match[1]), server.child.pid, "stale lock did not belong to the owned production child");
  await unlink(lockPath);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
}

async function terminateProductionProcess(server, password) {
  assert.equal(server.child.exitCode, null, "production process exited before forced termination");
  assert.equal(server.child.signalCode, null, "production process was already signaled");
  await terminateOwnedProcess(server.child);
  assert.ok(server.child.exitCode !== null || server.child.signalCode !== null, "owned production process remained alive after termination");
  assert.equal(server.output.secretLeak, false, "local-user secret appeared in production child output");
  assert.equal(server.output.overflow, false, "production child output exceeded the bounded capture limit");
  assert.equal(`${server.output.stdout}\n${server.output.stderr}`.includes(password), false);
}

async function stopOwnedChild(child, password) {
  if (child.exitCode === null && child.signalCode === null) {
    await terminateOwnedProcess(child);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "owned production child is still running; disposable home was preserved");
  assert.equal(child.outputCapture?.secretLeak, false);
  if (password) assert.equal(`${child.outputCapture?.stdout}\n${child.outputCapture?.stderr}`.includes(password), false);
}

async function cleanupOwnedTemporaryRoot(child, password, temporaryRoot) {
  let stopError;
  try {
    if (child) await stopOwnedChild(child, password);
  } catch (error) {
    stopError = error;
  }

  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  let rootError;
  if (childExited) {
    try {
      await removeOwnedTemporaryRoot(temporaryRoot);
    } catch (error) {
      rootError = error;
    }
  } else {
    rootError = new Error(`temporary root was preserved because its child is still running: ${temporaryRoot}`);
  }

  if (stopError && rootError) throw new AggregateError([stopError, rootError], "owned process cleanup failed");
  if (stopError) throw stopError;
  if (rootError) throw rootError;
}

function safeErrorMessage(error, secret) {
  const messages = error instanceof AggregateError
    ? [...error.errors].map((item) => safeErrorMessage(item, secret))
    : [error instanceof Error ? error.message : "unknown cleanup failure"];
  return messages.join("; ").replaceAll(secret, "[REDACTED]").slice(0, 1200);
}

async function terminateOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Windows Node implements SIGTERM as immediate process termination; this is not an app shutdown API.
    assert.equal(child.kill("SIGTERM"), true, "could not terminate the owned production process");
  } else {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitForExit(child, shutdownTimeoutMs);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit({ code, signal });
    };
    const onError = (error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.off("error", onError);
      reject(new Error("production child did not exit within the bounded timeout"));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function createRepository(repository, name, branch) {
  const configDirectory = join(repository, ".ebb-orchestrator");
  const hooksDirectory = join(repository, "acceptance-empty-hooks");
  await mkdir(configDirectory, { recursive: true });
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(join(configDirectory, "project.yaml"), configText(name, branch), "utf8");
  git(repository, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
  git(repository, ["config", "--local", "user.name", "Ebb Plan 06 Acceptance"]);
  git(repository, ["config", "--local", "user.email", "plan06-acceptance@example.invalid"]);
  git(repository, ["-c", `core.hooksPath=${hooksDirectory}`, "add", ".ebb-orchestrator/project.yaml"]);
  git(repository, ["-c", `core.hooksPath=${hooksDirectory}`, "commit", "--quiet", "-m", "acceptance fixture"]);
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf8",
  }).trim();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function migrationSnapshot(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all();
  } finally {
    database.close();
  }
}

function assertProjectBranch(snapshot, expected, label) {
  const project = snapshot?.project?.project;
  const actual = project?.default_branch;
  assert.equal(actual, expected, `${label} did not retain the expected normalized field; project keys=${Object.keys(project ?? {}).join(",")}`);
}

async function verifyMigrationBackup(home) {
  const backupsPath = join(home, "backups");
  const entries = await readdir(backupsPath);
  const backupPath = entries.map((entry) => join(backupsPath, entry)).find((path) => path.endsWith(".sqlite"));
  assert.ok(backupPath, "production startup did not create its pre-migration backup");
  assertPathWithin(await realpath(home), await realpath(backupPath), "migration backup");
  const database = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

function countTaskRuns(databasePath, taskId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=?").get(taskId).count;
  } finally {
    database.close();
  }
}

function approvalMetadataCount(databasePath, candidateId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT metadata_json FROM approval_metadata").all()
      .filter((row) => {
        const metadata = JSON.parse(row.metadata_json);
        return metadata.kind === "project-config" && metadata.candidateId === candidateId;
      }).length;
  } finally {
    database.close();
  }
}

function projectApprovalSideEffectSnapshot(databasePath, projectId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const approvals = database.prepare(
      `SELECT a.id,a.type,a.subject_id,a.subject_type,a.status,a.resolved_by,a.resolution_note,a.resolved_at,m.metadata_json
       FROM approvals a LEFT JOIN approval_metadata m ON m.approval_id=a.id
       WHERE a.subject_id=? AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE' ORDER BY a.id`,
    ).all(projectId);
    const outbox = database.prepare(
      `SELECT id,type,aggregate_type,aggregate_id,payload_json FROM outbox_events
       WHERE aggregate_type='Approval' AND aggregate_id=? AND type IN ('ApprovalRequested','ApprovalApproved') ORDER BY id`,
    ).all(projectId);
    const audit = database.prepare(
      "SELECT id,action,aggregate_type,aggregate_id,details_json FROM audit_log WHERE aggregate_type='Approval' ORDER BY id",
    ).all()
      .filter((row) => {
        const details = JSON.parse(row.details_json);
        return details.subjectId === projectId && details.approvalType === "WORKFLOW_CHANGE";
      });
    return { approvals, outbox, audit };
  } finally {
    database.close();
  }
}

function revisionApprovalId(databasePath, projectId, revisionId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT approval_id FROM project_config_revisions WHERE project_id=? AND revision_id=?").get(projectId, revisionId);
    assert.ok(row?.approval_id, "committed revision has no approval provenance");
    return row.approval_id;
  } finally {
    database.close();
  }
}

function assertProjectApprovalSideEffectDelta(before, after, revision, candidate, projectId, approvalId) {
  const oldApprovalIds = new Set(before.approvals.map(({ id }) => id));
  const newApprovals = after.approvals.filter(({ id }) => !oldApprovalIds.has(id));
  assert.equal(newApprovals.length, 1, "commit did not add exactly one project-scoped approval row");
  assert.equal(newApprovals[0].id, approvalId);
  assert.equal(newApprovals[0].status, "APPROVED");
  const approvalMetadata = JSON.parse(newApprovals[0].metadata_json);
  assert.equal(approvalMetadata.kind, "project-config");
  assert.equal(approvalMetadata.candidateId, candidate.candidateId);
  assert.equal(approvalMetadata.manifestHash, candidate.manifestHash);
  assert.equal(approvalMetadata.revisionHash, revision.revisionHash);

  const oldOutboxIds = new Set(before.outbox.map(({ id }) => id));
  const newOutbox = after.outbox.filter(({ id }) => !oldOutboxIds.has(id));
  assert.equal(newOutbox.length, 2, "commit did not add exactly two project-scoped approval outbox events");
  const outboxEvents = newOutbox.map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json) }));
  assert.deepEqual(outboxEvents.map(({ type }) => type).sort(), ["ApprovalApproved", "ApprovalRequested"]);
  for (const { payload } of outboxEvents) {
    assert.equal(payload.approvalId, approvalId);
    assert.equal(payload.approvalType, "WORKFLOW_CHANGE");
    assert.equal(payload.subjectId, projectId);
    assert.equal(payload.subjectType, "PROJECT");
  }

  const oldAuditIds = new Set(before.audit.map(({ id }) => id));
  const newAudit = after.audit.filter(({ id }) => !oldAuditIds.has(id));
  assert.equal(newAudit.length, 1, "commit did not add exactly one project-scoped approval audit row");
  const auditDetails = JSON.parse(newAudit[0].details_json);
  assert.equal(newAudit[0].action, "APPROVAL_APPROVED");
  assert.equal(auditDetails.approvalId, approvalId);
  assert.equal(auditDetails.subjectId, projectId);
  assert.equal(auditDetails.approvalType, "WORKFLOW_CHANGE");
  assert.equal(auditDetails.status, "APPROVED");
}

async function createActivePointerFaultObserver(scenarioRoot, home, databasePath) {
  assertPathWithin(await realpath(scenarioRoot), await realpath(home), "fault observer home");
  assertPathWithin(await realpath(home), await realpath(databasePath), "fault observer database");
  const preloadPath = join(scenarioRoot, "plan06-active-pointer-fault-observer.mjs");
  const markerPath = join(scenarioRoot, "plan06-active-pointer-trigger-observed");
  const markerContents = "PLAN06_ACTIVE_POINTER_TRIGGER=OBSERVED\n";
  const source = `
import { writeFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { resolve } from "node:path";

const expectedDatabase = normalizePath(process.env.PLAN06_FAULT_OBSERVER_DATABASE);
const markerPath = process.env.PLAN06_FAULT_OBSERVER_MARKER;
const sentinel = "plan06 injected failure before active pointer commit";
const expectedSql = normalizeSql(${JSON.stringify(pointerUpdateSql)});
if (!expectedDatabase || !markerPath) throw new Error("Plan 06 fault observer configuration is missing");

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function normalizeSql(value) { return String(value).replace(/\\s+/g, " ").trim(); }

const observedStatements = new WeakSet();
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql, ...options) {
  const statement = originalPrepare.call(this, sql, ...options);
  if (normalizePath(this.location()) === expectedDatabase && normalizeSql(sql) === expectedSql) observedStatements.add(statement);
  return statement;
};

const originalRun = StatementSync.prototype.run;
StatementSync.prototype.run = function(...parameters) {
  try { return originalRun.apply(this, parameters); }
  catch (error) {
    if (observedStatements.has(this) && error?.code === "ERR_SQLITE_ERROR" && error?.errcode === 1811 && error?.message === sentinel) {
      try { writeFileSync(markerPath, ${JSON.stringify(markerContents)}, { flag: "wx", mode: 0o600 }); }
      catch { /* Missing marker is reported by the parent acceptance assertion. */ }
    }
    throw error;
  }
};
`;
  await writeFile(preloadPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  assertPathWithin(await realpath(scenarioRoot), await realpath(preloadPath), "fault observer preload");
  return { root: scenarioRoot, preloadPath, markerDirectory: scenarioRoot, markerPath, markerContents, databasePath };
}

async function createPostCommitCrashObserver(scenarioRoot, home, databasePath, projectId, candidate, previousRevisionId) {
  assertPathWithin(await realpath(scenarioRoot), await realpath(home), "post-commit observer home");
  assertPathWithin(await realpath(home), await realpath(databasePath), "post-commit observer database");
  assert.match(projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(candidate.candidateId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(candidate.manifestHash, /^[0-9a-f]{64}$/);
  assert.match(previousRevisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const preloadPath = join(scenarioRoot, "plan06-post-commit-crash-observer.mjs");
  const markerPath = join(scenarioRoot, "plan06-post-commit-observed.json");
  const source = `
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const expectedDatabase = normalizePath(${JSON.stringify(databasePath)});
const expectedProjectId = ${JSON.stringify(projectId)};
const expectedCandidateId = ${JSON.stringify(candidate.candidateId)};
const expectedManifestHash = ${JSON.stringify(candidate.manifestHash)};
const expectedPreviousRevisionId = ${JSON.stringify(previousRevisionId)};
const markerPath = ${JSON.stringify(markerPath)};

function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function normalizeSql(value) { return String(value).replace(/\\s+/g, " ").trim(); }
function holdCommittedChildUntilParentKills() {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(waitCell, 0, 0, 100);
}

const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql, ...options) {
  const result = originalExec.call(this, sql, ...options);
  if (normalizePath(this.location()) !== expectedDatabase || normalizeSql(sql) !== "COMMIT") return result;
  const row = this.prepare(
    "SELECT s.current_candidate_id,s.active_revision_id,c.status AS candidate_status,r.candidate_id,r.manifest_hash,r.revision_hash,r.approval_id,a.status AS approval_status,m.metadata_json " +
    "FROM project_config_state s " +
    "JOIN project_config_revisions r ON r.revision_id=s.active_revision_id AND r.project_id=s.project_id " +
    "JOIN project_config_candidates c ON c.candidate_id=s.current_candidate_id AND c.project_id=s.project_id " +
    "JOIN approvals a ON a.id=r.approval_id AND a.subject_id=r.project_id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE' " +
    "JOIN approval_metadata m ON m.approval_id=a.id WHERE s.project_id=?",
  ).get(expectedProjectId);
  if (!row) return result;
  const metadata = JSON.parse(row.metadata_json);
  if (row.current_candidate_id !== expectedCandidateId || row.active_revision_id === expectedPreviousRevisionId ||
      row.candidate_id !== expectedCandidateId || row.candidate_status !== "APPROVED_ACTIVE" ||
      row.manifest_hash !== expectedManifestHash || row.approval_status !== "APPROVED" ||
      metadata.kind !== "project-config" || metadata.candidateId !== expectedCandidateId ||
      metadata.manifestHash !== expectedManifestHash || metadata.revisionHash !== row.revision_hash) return result;
  const evidence = {
    event: "PLAN06_POST_COMMIT_ACTIVE_POINTER",
    projectId: expectedProjectId,
    candidateId: row.current_candidate_id,
    previousRevisionId: expectedPreviousRevisionId,
    revisionId: row.active_revision_id,
    revisionHash: row.revision_hash,
    manifestHash: row.manifest_hash,
    approvalId: row.approval_id,
  };
  writeFileSync(markerPath, JSON.stringify(evidence) + "\\n", { flag: "wx", mode: 0o600 });
  holdCommittedChildUntilParentKills();
  return result;
};
`;
  await writeFile(preloadPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  assertPathWithin(await realpath(scenarioRoot), await realpath(preloadPath), "post-commit observer preload");
  assertPathWithin(await realpath(scenarioRoot), markerPath, "post-commit observer marker");
  return { root: scenarioRoot, preloadPath, markerDirectory: scenarioRoot, markerPath, databasePath };
}

async function createPreCommitCrashObserver(scenarioRoot, home, databasePath, projectId, candidate, previousRevisionId) {
  assertPathWithin(await realpath(scenarioRoot), await realpath(home), "pre-commit observer home");
  assertPathWithin(await realpath(home), await realpath(databasePath), "pre-commit observer database");
  assert.match(projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(candidate.candidateId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(candidate.manifestHash, /^[0-9a-f]{64}$/);
  assert.match(previousRevisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const preloadPath = join(scenarioRoot, "plan06-pre-commit-crash-observer.mjs");
  const markerPath = join(scenarioRoot, "plan06-pre-commit-observed.json");
  const source = `
import { writeFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { resolve } from "node:path";

const expectedDatabase = normalizePath(${JSON.stringify(databasePath)});
const expectedSql = normalizeSql(${JSON.stringify(pointerUpdateSql)});
const expectedProjectId = ${JSON.stringify(projectId)};
const expectedCandidateId = ${JSON.stringify(candidate.candidateId)};
const expectedManifestHash = ${JSON.stringify(candidate.manifestHash)};
const expectedPreviousRevisionId = ${JSON.stringify(previousRevisionId)};
const markerPath = ${JSON.stringify(markerPath)};
function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function normalizeSql(value) { return String(value).replace(/\\s+/g, " ").trim(); }
function holdUncommittedChildUntilParentKills() {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(waitCell, 0, 0, 100);
}

const statementOwners = new WeakMap();
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql, ...options) {
  const statement = originalPrepare.call(this, sql, ...options);
  statementOwners.set(statement, { database: this, sql: String(sql) });
  return statement;
};

const originalRun = StatementSync.prototype.run;
StatementSync.prototype.run = function(...parameters) {
  const result = originalRun.apply(this, parameters);
  const owner = statementOwners.get(this);
  if (!owner || normalizePath(owner.database.location()) !== expectedDatabase || normalizeSql(owner.sql) !== expectedSql) return result;
  const bindings = parameters[0];
  if (!bindings || bindings.$projectId !== expectedProjectId || bindings.$candidateId !== expectedCandidateId ||
      bindings.$expectedRevision !== expectedPreviousRevisionId || owner.database.isTransaction !== true) return result;
  const row = owner.database.prepare(
    "SELECT s.current_candidate_id,s.active_revision_id,c.status AS candidate_status,r.revision_id,r.candidate_id,r.manifest_hash,r.revision_hash,r.approval_id,a.status AS approval_status,m.metadata_json " +
    "FROM project_config_state s " +
    "JOIN project_config_revisions r ON r.revision_id=s.active_revision_id AND r.project_id=s.project_id " +
    "JOIN project_config_candidates c ON c.candidate_id=s.current_candidate_id AND c.project_id=s.project_id " +
    "JOIN approvals a ON a.id=r.approval_id AND a.subject_id=r.project_id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE' " +
    "JOIN approval_metadata m ON m.approval_id=a.id WHERE s.project_id=?",
  ).get(expectedProjectId);
  if (!row || row.current_candidate_id !== expectedCandidateId || row.active_revision_id !== bindings.$revisionId ||
      row.candidate_id !== expectedCandidateId || row.revision_id !== bindings.$revisionId ||
      row.candidate_status !== "APPROVED_ACTIVE" || row.manifest_hash !== expectedManifestHash ||
      row.approval_status !== "APPROVED" || owner.database.isTransaction !== true) return result;
  const metadata = JSON.parse(row.metadata_json);
  if (metadata.kind !== "project-config" || metadata.candidateId !== expectedCandidateId ||
      metadata.manifestHash !== expectedManifestHash || metadata.revisionHash !== row.revision_hash) return result;
  const evidence = {
    event: "PLAN06_PRE_COMMIT_ACTIVE_POINTER",
    projectId: expectedProjectId,
    candidateId: row.current_candidate_id,
    previousRevisionId: expectedPreviousRevisionId,
    activeRevisionId: row.active_revision_id,
    revisionId: row.revision_id,
    revisionHash: row.revision_hash,
    manifestHash: row.manifest_hash,
    approvalId: row.approval_id,
    transactionOpen: owner.database.isTransaction === true,
  };
  writeFileSync(markerPath, JSON.stringify(evidence) + "\\n", { flag: "wx", mode: 0o600 });
  holdUncommittedChildUntilParentKills();
  return result;
};
`;
  await writeFile(preloadPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  assertPathWithin(await realpath(scenarioRoot), await realpath(preloadPath), "pre-commit observer preload");
  assertPathWithin(await realpath(scenarioRoot), markerPath, "pre-commit observer marker");
  return { root: scenarioRoot, preloadPath, markerDirectory: scenarioRoot, markerPath, databasePath };
}

async function installActivePointerFailureTrigger(databasePath, home, projectId) {
  assertPathWithin(await realpath(home), await realpath(databasePath), "fault-injection database");
  assert.match(projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const state = database.prepare("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=?").get(projectId);
    assert.ok(state?.active_revision_id && state.current_candidate_id, "fault injection requires an existing active revision and pending candidate");
    database.exec(`CREATE TRIGGER trg_plan06_fail_before_active_pointer_update
      BEFORE UPDATE OF active_revision_id ON project_config_state
      WHEN OLD.project_id = '${projectId}' AND NEW.active_revision_id IS NOT OLD.active_revision_id
      BEGIN SELECT RAISE(ABORT, 'plan06 injected failure before active pointer commit'); END`);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='trg_plan06_fail_before_active_pointer_update'").get().count, 1);
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    database.close();
  }
}

async function removeOwnedTemporaryRoot(temporaryRoot) {
  const systemTemporaryRoot = await realpath(tmpdir());
  const target = await realpath(temporaryRoot);
  assertPathWithin(systemTemporaryRoot, target, "owned temporary root");
  assert.notEqual(target, systemTemporaryRoot, "refusing to remove the system temporary root");
  await rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  await assert.rejects(realpath(temporaryRoot), { code: "ENOENT" });
}

function assertPathWithin(parent, candidate, label) {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  assert.ok(
    pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent)),
    `${label} escaped its owned root`,
  );
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAcceptance().catch((error) => {
    console.error("PLAN06_PROJECT_CONFIG_RESTART_ACCEPTANCE=FAIL");
    console.error(error instanceof Error ? error.message : "unknown failure");
    process.exitCode = 1;
  });
}
