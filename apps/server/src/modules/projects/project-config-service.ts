import { constants } from "node:fs";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { isAllowedDefaultBranch, parseProjectConfig, parseProjectConfigV2, parseProjectConfigYaml, type ProjectConfigV1 } from "../../platform/config/project-config.js";
import type { ApprovalTransactionPort } from "../approvals/approval-port.js";
import { ProjectConfigRepository, ProjectConfigRepositoryConflictError, type ProjectConfigCandidateRecord, type ProjectConfigCandidateStatus, type ProjectConfigRevisionRecord, type ProjectConfigStateRecord, type ProjectConfigWriteJournalRecord } from "./project-config-repository.js";

type CandidateRow = ProjectConfigCandidateRecord;
type RevisionRow = ProjectConfigRevisionRecord;
interface FileSnapshot { readonly path: string; readonly state: "present" | "deleted"; readonly sha256: string | null; }
interface CaptureResult {
  readonly sourceHead: string;
  readonly manifest: readonly FileSnapshot[];
  readonly manifestJson: string;
  readonly manifestHash: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly normalizedPayload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: number;
}

const MAX_PROJECT_CONFIG_FILES = 100;
const MAX_PROJECT_CONFIG_FILE_BYTES = 1_048_576;
const MAX_PROJECT_CONFIG_TOTAL_BYTES = 5_242_880;

export interface ProjectConfigCandidate {
  readonly candidateId: string;
  readonly projectId: string;
  readonly sourceHead: string;
  readonly manifest: readonly FileSnapshot[];
  readonly manifestHash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly normalizedPreview: Readonly<Record<string, unknown>>;
  readonly status: ProjectConfigCandidateStatus;
  readonly createdAt: string;
}
/** Представляет неизменяемую approved revision и её проверяемую provenance. */
export interface ProjectConfigRevision {
  readonly revisionId: string;
  readonly candidateId: string;
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly normalizedConfig: Readonly<Record<string, unknown>>;
  readonly manifestHash: string;
  readonly revisionHash: string;
  readonly manifest: readonly FileSnapshot[];
  readonly files: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

/** Представляет отказ Project Config lifecycle без раскрытия внутренних деталей хранения. */
export class ProjectConfigError extends Error {
  constructor(readonly code: "PROJECT_CONFIG_PROJECT_NOT_FOUND" | "PROJECT_CONFIG_NOT_FOUND" | "PROJECT_CONFIG_INVALID" | "PROJECT_CONFIG_UNSTABLE" | "PROJECT_CONFIG_CANDIDATE_NOT_CURRENT" | "PROJECT_CONFIG_ACTIVE_INVALID" | "PROJECT_CONFIG_UNSUPPORTED_PLATFORM" | "PROJECT_CONFIG_JOURNAL_ACTIVE" | "PROJECT_CONFIG_JOURNAL_DEGRADED", message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Владеет reviewable repository candidates и единственным путём активации approved Project Config. */
export class ProjectConfigService {
  private readonly repository: ProjectConfigRepository;

  constructor(private readonly database: Database, private readonly approvals: ApprovalTransactionPort, repository?: ProjectConfigRepository) {
    this.repository = repository ?? new ProjectConfigRepository(database);
  }

  /** Снимает стабильный immutable snapshot только из canonical `.ebb-orchestrator/` каталога. */
  capture(projectId: string): ProjectConfigCandidate {
    if (process.platform === "win32") {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSUPPORTED_PLATFORM", "Project Config capture is disabled on Windows until safe file-handle verification is supported.");
    }
    if (this.repository.getActiveJournal(projectId)) {
      throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_ACTIVE", "A Project Config write journal is active; complete or reconcile it first.");
    }
    const root = this.repositoryRoot(projectId);
    const first = captureRepository(root);
    const second = captureRepository(root);
    if (first.manifestHash !== second.manifestHash || first.sourceHead !== second.sourceHead) {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config changed during capture; retry after repository changes stop.");
    }
    const row = this.repository.capture({
      projectId,
      sourceHead: first.sourceHead,
      manifestJson: first.manifestJson,
      manifestHash: first.manifestHash,
      sourceFilesJson: JSON.stringify(first.sourceFiles),
      normalizedPayloadJson: canonicalJson(first.normalizedPayload),
      schemaVersion: first.schemaVersion,
    });
    return candidateFromRow(row);
  }

  /** Возвращает текущий persisted candidate и никогда не читает live repository для отображения diff. */
  getCurrentCandidate(projectId: string): ProjectConfigCandidate | undefined {
    const row = this.repository.getCurrentCandidate(projectId);
    if (!row) return undefined;
    if (!candidateIntegrityValid(row)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Persisted Project Config candidate failed integrity validation.");
    return candidateFromRow(row);
  }

  /** Возвращает историю Project Config от новых revisions к старым для явного восстановления. */
  listRevisions(projectId: string): ProjectConfigRevision[] {
    return this.repository.listRevisions(projectId)
      .filter(revisionIntegrityValid).map(revisionFromRow);
  }

  /** Явно одобряет только показанный current candidate и атомарно меняет active revision. */
  approve(projectId: string, candidateId: string, expectedManifestHash: string): ProjectConfigRevision {
    const candidate = this.repository.getCandidate(projectId, candidateId);
    if (candidate?.schema_version === 2) {
      return this.editorApprove(projectId, candidateId, expectedManifestHash);
    }
    let row: RevisionRow | undefined;
    try {
      row = this.repository.approveCandidate(projectId, candidateId, expectedManifestHash, (tx, candidate) => {
        if (!candidateIntegrityValid(candidate)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Persisted Project Config candidate failed integrity validation.");
        const payload = JSON.parse(candidate.normalized_payload_json) as Record<string, unknown>;
        const revisionHash = hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload));
        const revisionId = randomUUID();
        const approval = this.approvals.requestInTransaction(tx, {
          type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "local-user",
          metadata: { kind: "project-config", candidateId, manifestHash: candidate.manifest_hash, revisionHash },
        });
        this.approvals.approveInTransaction(tx, {
          approvalId: approval.id, subjectId: projectId, subjectType: "PROJECT", type: "WORKFLOW_CHANGE", actor: "local-user",
          note: `Project Config candidate ${candidateId} approved (${candidate.manifest_hash})`,
        });
        const now = new Date().toISOString();
        return { revisionId, revisionHash, approvalId: approval.id, createdAt: now };
      });
    } catch (error) {
      if (error instanceof ProjectConfigRepositoryConflictError) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate changed during approval.");
      throw error;
    }
    if (!row) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate is stale or no longer current.");
    return revisionFromRow(row);
  }

  /** Возвращает только approved active revision и fail-closed при integrity mismatch. */
  getActive(projectId: string): ProjectConfigRevision | undefined {
    const { state, revision: row } = this.repository.getActiveRevision(projectId);
    if (state?.config_status === "DEGRADED") throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Project Config is degraded and requires explicit recovery.");
    if (!state?.active_revision_id) return undefined;
    if (!row) {
      this.repository.markDegraded(projectId, state.active_revision_id);
      throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision is missing or its approval is invalid.");
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.normalized_payload_json) as Record<string, unknown>;
      const project = parseProjectConfig(payload.project);
      const schemaOk = row.schema_version === 2 ? project.schema_version === 1 : project.schema_version === row.schema_version;
      if (!schemaOk || row.approval_status !== "APPROVED") throw new Error("unsupported active config");
      const actual = hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload));
      const manifestActual = hashDomain("ebb-project-config-manifest-v1\0", row.manifest_json);
      if (actual !== row.revision_hash || manifestActual !== row.manifest_hash || !snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)) throw new Error("active config integrity mismatch");
      if (JSON.stringify(payload.files) !== JSON.stringify(JSON.parse(row.source_files_json))) throw new Error("active source snapshot binding mismatch");
    } catch {
      this.repository.markDegraded(projectId, state.active_revision_id);
      throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision failed integrity validation.");
    }
    return revisionFromRow(row);
  }

  /** Проверяет все active revisions перед READY и помечает повреждённые Projects как DEGRADED. */
  reconcileActiveOnStartup(): void {
    const projectIds = this.repository.listActiveProjectIds();
    for (const projectId of projectIds) {
      try { this.getActive(projectId); }
      catch (error) {
        if (!(error instanceof ProjectConfigError) || error.code !== "PROJECT_CONFIG_ACTIVE_INVALID") throw error;
      }
    }
    this.recoverJournalsOnStartup();
  }

  /** Ставит исторический approved snapshot на review; он становится active только после нового точного approval. */
  stageRollback(projectId: string, revisionId: string): ProjectConfigCandidate {
    const row = this.repository.stageRollback(projectId, revisionId, revisionIntegrityValid);
    if (!row) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Historical Project Config revision cannot be restored.");
    return candidateFromRow(row);
  }

  /**
   * Сохраняет editor-кандидата (v2) как immutable bytes/manifest в SQLite.
   * Не пишет файлы репозитория, не создаёт журнал и не меняет active revision.
   * `expectedManifestHash` обязан совпасть с текущим canonical manifest репозитория.
   */
  saveEditorCandidate(projectId: string, expectedManifestHash: string, settings: unknown): ProjectConfigCandidate {
    if (process.platform === "win32") throw this.unsupportedPlatformError();
    if (this.repository.getActiveJournal(projectId)) {
      throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_ACTIVE", "A Project Config write journal is active; complete or reconcile it first.");
    }
    const root = this.repositoryRoot(projectId);
    const baseline = captureRepository(root);
    if (baseline.manifestHash !== expectedManifestHash) {
      throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate is stale; manifest changed since the editor baseline.");
    }
    let parsed: ReturnType<typeof parseProjectConfigV2>;
    try { parsed = parseProjectConfigV2(settings); }
    catch (error) {
      throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Project Config v2 settings are invalid: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const onboardingDefaultBranch = this.onboardingDefaultBranch(projectId);
    if (!isAllowedDefaultBranch(parsed.defaultBranch, onboardingDefaultBranch)) {
      throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Default branch is not allowed by the project branch policy.");
    }
    const baselineDefault = (baseline.normalizedPayload.project as { project: { default_branch: string } }).project.default_branch;
    const targetBranch = parsed.defaultBranch ?? baselineDefault;
    const rendered = renderProjectConfigV2Files(baseline, parsed, targetBranch, expectedManifestHash);
    const row = this.repository.capture({
      projectId,
      sourceHead: baseline.sourceHead,
      manifestJson: rendered.manifestJson,
      manifestHash: rendered.manifestHash,
      sourceFilesJson: JSON.stringify(rendered.files),
      normalizedPayloadJson: canonicalJson(rendered.payload),
      schemaVersion: 2,
    });
    return candidateFromRow(row);
  }

  /**
   * Exact-hash approval редакторского кандидата. Создаёт approved immutable revision
   * и PREPARED журнал (candidate остаётся PENDING_REVIEW, active не меняется), затем
   * writer применяет allowlisted файлы, проверяет manifest и одной транзакцией
   * фиксирует APPLIED + APPROVED_ACTIVE + advance active revision.
   */
  editorApprove(projectId: string, candidateId: string, expectedManifestHash: string): ProjectConfigRevision {
    if (process.platform === "win32") throw this.unsupportedPlatformError();
    const root = this.repositoryRoot(projectId);
    const journal = this.repository.getActiveJournal(projectId);
    if (journal) throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_ACTIVE", "A Project Config write journal is active; complete or reconcile it first.");
    const candidate = this.repository.getCandidate(projectId, candidateId);
    if (!candidate || candidate.status !== "PENDING_REVIEW" || candidate.schema_version !== 2 || candidate.manifest_hash !== expectedManifestHash) {
      throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate is stale or not the current editor candidate.");
    }
    const meta = parseCandidateMeta(candidate);
    const state = this.repository.getState(projectId);
    const journalId = randomUUID();
    let revisionId: string;
    let approvalId: string;
    try {
      const prepared = this.repository.approvePreparedCandidate(projectId, candidateId, expectedManifestHash, (tx, candidateRow) => {
        const payload = JSON.parse(candidateRow.normalized_payload_json) as Record<string, unknown>;
        const revisionHash = hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload));
        const revision = randomUUID();
        const approval = this.approvals.requestInTransaction(tx, {
          type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "local-user",
          metadata: { kind: "project-config-editor", candidateId, manifestHash: candidateRow.manifest_hash, revisionHash },
        });
        this.approvals.approveInTransaction(tx, {
          approvalId: approval.id, subjectId: projectId, subjectType: "PROJECT", type: "WORKFLOW_CHANGE", actor: "local-user",
          note: `Project Config editor candidate ${candidateId} approved (${candidateRow.manifest_hash})`,
        });
        return { revisionId: revision, revisionHash, approvalId: approval.id, createdAt: new Date().toISOString() };
      });
      if (!prepared) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate changed during approval.");
      revisionId = prepared.revision.revision_id;
      approvalId = prepared.revision.approval_id;
      this.repository.createJournalInTransaction(this.database, {
        id: journalId, projectId, candidateId, approvalId,
        expectedManifestHash: meta.expectedManifestHash,
        oldFilesJson: JSON.stringify(meta.baselineFiles),
        newFilesJson: candidate.source_files_json,
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ProjectConfigRepositoryConflictError) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate changed during approval.");
      throw error;
    }
    this.applyJournal(projectId, journalId, candidate, meta, state?.active_revision_id ?? null, root);
    const revisionRow = this.database.get<RevisionRow>("SELECT * FROM project_config_revisions WHERE revision_id=$id AND project_id=$projectId", { id: revisionId, projectId });
    if (!revisionRow || !revisionIntegrityValid(revisionRow)) throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision failed integrity validation.");
    return revisionFromRow(revisionRow);
  }

  /** Выполняет writer-фазу журнала и фиксирует результат одной транзакцией. */
  private applyJournal(
    projectId: string,
    journalId: string,
    candidate: ProjectConfigCandidateRecord,
    meta: CandidateMeta,
    expectedActiveRevisionId: string | null,
    root: string,
  ): void {
    if (process.platform === "win32") throw this.unsupportedPlatformError();
    const now = new Date().toISOString();
    // Pre-write proof: текущий manifest обязан совпасть с редакторским baseline.
    let observed: CaptureResult;
    try { observed = captureRepository(root); }
    catch { observed = undefined as never; }
    if (!observed || observed.manifestHash !== meta.baselineManifestHash) {
      this.repository.markJournalDegraded(journalId, projectId, "UNEXPLAINED_EXTERNAL_MODIFICATION", now);
      throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_DEGRADED", "Project Config changed externally before apply; reconcile is required.");
    }
    if (!this.repository.updateJournalPhase(journalId, "PREPARED", "WRITING", now)) {
      throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_ACTIVE", "Journal phase changed during apply.");
    }
    try {
      const newFiles = decodeFilesJson(candidate.source_files_json);
      writeProjectConfigFiles(root, newFiles);
      const verified = captureRepository(root);
      if (verified.manifestHash !== candidate.manifest_hash) throw new Error("manifest verification failed after write");
    } catch {
      this.repository.markJournalDegraded(journalId, projectId, "WRITE_OR_VERIFY_FAILED", new Date().toISOString());
      throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_DEGRADED", "Project Config file write could not be verified; reconcile is required.");
    }
    const applied = this.database.transaction((tx) => {
      const current = tx.get<ProjectConfigStateRecord>("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=$projectId", { projectId });
      if (!current || current.current_candidate_id !== candidate.candidate_id) return false;
      const revisionId = revisionIdForCandidateTx(tx, projectId, candidate.candidate_id);
      if (!revisionId) return false;
      return this.repository.applyJournalTx(tx, journalId, projectId, candidate.candidate_id, revisionId, expectedActiveRevisionId, new Date().toISOString());
    });
    if (!applied) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config apply transaction lost its CAS.");
  }

  /** Завершает незавершённый PREPARED/WRITING журнал при старте. */
  recoverJournalsOnStartup(): void {
    const projectIds = this.database.all<{ project_id: string }>("SELECT DISTINCT project_id FROM project_config_write_journal WHERE phase IN ('PREPARED','WRITING')");
    for (const { project_id: projectId } of projectIds) {
      try { this.recoverJournal(projectId); } catch { /* следующий цикл повторит; DEGRADED остаётся видимым */ }
    }
  }

  private recoverJournal(projectId: string): void {
    const journal = this.repository.getActiveJournal(projectId);
    if (!journal || (journal.phase !== "PREPARED" && journal.phase !== "WRITING")) return;
    if (process.platform === "win32") {
      this.repository.markJournalDegraded(journal.id, projectId, "PLATFORM_UNSUPPORTED_WRITE", new Date().toISOString());
      return;
    }
    const root = this.repositoryRoot(projectId);
    const candidate = this.repository.getCandidate(projectId, journal.candidate_id);
    const state = this.repository.getState(projectId);
    if (!candidate || !state) {
      this.repository.markJournalDegraded(journal.id, projectId, "CANDIDATE_OR_STATE_MISSING", new Date().toISOString());
      return;
    }
    const oldFiles = decodeFilesJson(journal.old_files_json);
    const newFiles = decodeFilesJson(journal.new_files_json);
    const oldHashes = fileHashes(oldFiles);
    const newHashes = fileHashes(newFiles);
    let observed: CaptureResult;
    try { observed = captureRepository(root); }
    catch {
      this.repository.markJournalDegraded(journal.id, projectId, "UNEXPLAINED_EXTERNAL_MODIFICATION", new Date().toISOString());
      return;
    }
    for (const snapshot of observed.manifest) {
      if (snapshot.state !== "present") continue;
      const oldHash = oldHashes.get(snapshot.path);
      const newHash = newHashes.get(snapshot.path);
      if (newHash === snapshot.sha256) continue;
      if (oldHash === snapshot.sha256) continue;
      this.repository.markJournalDegraded(journal.id, projectId, "UNEXPLAINED_EXTERNAL_MODIFICATION", new Date().toISOString());
      return;
    }
    // Все наблюдаемые файлы объяснимы old/approved-new: дописываем new и фиксируем.
    const now = new Date().toISOString();
    if (!this.repository.updateJournalPhase(journal.id, journal.phase, "WRITING", now)) return;
    try {
      writeProjectConfigFiles(root, newFiles);
      const verified = captureRepository(root);
      if (verified.manifestHash !== candidate.manifest_hash) throw new Error("recovered manifest mismatch");
    } catch {
      this.repository.markJournalDegraded(journal.id, projectId, "WRITE_OR_VERIFY_FAILED", new Date().toISOString());
      return;
    }
    const applied = this.database.transaction((tx) => {
      const current = tx.get<ProjectConfigStateRecord>("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=$projectId", { projectId });
      if (!current || current.current_candidate_id !== candidate.candidate_id) return false;
      const revisionId = revisionIdForCandidateTx(tx, projectId, candidate.candidate_id);
      if (!revisionId) return false;
      return this.repository.applyJournalTx(tx, journal.id, projectId, candidate.candidate_id, revisionId, state.active_revision_id, new Date().toISOString());
    });
    void applied;
  }

  /**
   * Явный reconcile DEGRADED журнала. Только терминальные RECONCILED_* фазы;
   * retry/restart возвращают существующий результат и никогда не начинают второй write.
   */
  reconcileJournal(projectId: string, journalId: string, input: {
    expectedPhase: "DEGRADED"; observedManifestHash: string;
    resolution: "ACCEPT_EXTERNAL" | "RESTORE_APPROVED";
  }): JournalReconcileOutcome {
    const journal = this.repository.listJournals(projectId).find((entry) => entry.id === journalId);
    if (!journal) throw new ProjectConfigError("PROJECT_CONFIG_NOT_FOUND", "Project Config journal was not found.");
    if (journal.phase === "RECONCILED_EXTERNAL" || journal.phase === "RECONCILED_RESTORED") {
      return existingResolutionOutcome(journal, projectId, this.repository.getState(projectId));
    }
    if (journal.phase !== "DEGRADED" || input.expectedPhase !== "DEGRADED") {
      throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Journal is not in DEGRADED phase; reconciliation was rejected.");
    }
    if (process.platform === "win32") throw this.unsupportedPlatformError();
    const state = this.repository.getState(projectId);
    if (!state) throw new ProjectConfigError("PROJECT_CONFIG_NOT_FOUND", "Project Config state was not found.");
    const now = new Date().toISOString();
    if (input.resolution === "ACCEPT_EXTERNAL") {
      const observed = captureRepository(this.repositoryRoot(projectId));
      if (observed.manifestHash !== input.observedManifestHash) {
        throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Observed manifest does not match the reconcile request.");
      }
      // Свежий unapproved candidate из безопасно перечитанных canonical файлов.
      const rebuilt = this.repository.capture({
        projectId,
        sourceHead: observed.sourceHead,
        manifestJson: observed.manifestJson,
        manifestHash: observed.manifestHash,
        sourceFilesJson: JSON.stringify(observed.sourceFiles),
        normalizedPayloadJson: canonicalJson(observed.normalizedPayload),
        schemaVersion: observed.schemaVersion,
      });
      this.database.transaction((tx) => {
        this.repository.setCurrentCandidateTx(tx, projectId, rebuilt.candidate_id, now);
        if (!this.repository.closeJournalReconciledTx(tx, journalId, {
          resolution: "ACCEPT_EXTERNAL", resolvedBy: "local-user", resolvedManifestHash: observed.manifestHash, resolvedAt: now,
        })) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Journal reconciliation CAS failed.");
      });
      return { journalId, projectId, phase: "RECONCILED_EXTERNAL", configStatus: "READY", currentCandidateId: rebuilt.candidate_id, activeRevisionId: state.active_revision_id, resolution: "ACCEPT_EXTERNAL", resolvedBy: "local-user", resolvedManifestHash: observed.manifestHash, resolvedAt: now };
    }
    // RESTORE_APPROVED: только при доказуемых точных approved bytes.
    if (!state.active_revision_id) throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "No approved active revision exists to restore.");
    const { revision } = this.repository.getActiveRevision(projectId);
    if (!revision || !revisionIntegrityValid(revision)) throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved active revision is not provable.");
    const restoredFiles = decodeFilesJson(revision.source_files_json);
    writeProjectConfigFiles(this.repositoryRoot(projectId), restoredFiles);
    const verified = captureRepository(this.repositoryRoot(projectId));
    if (verified.manifestHash !== revision.manifest_hash) throw new ProjectConfigError("PROJECT_CONFIG_JOURNAL_DEGRADED", "Restored files failed manifest verification.");
    this.database.transaction((tx) => {
      this.repository.setCurrentCandidateTx(tx, projectId, revision.candidate_id, now);
      if (!this.repository.closeJournalReconciledTx(tx, journalId, {
        resolution: "RESTORE_APPROVED", resolvedBy: "local-user", resolvedManifestHash: revision.manifest_hash, resolvedAt: now,
      })) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Journal reconciliation CAS failed.");
    });
    return { journalId, projectId, phase: "RECONCILED_RESTORED", configStatus: "READY", currentCandidateId: revision.candidate_id, activeRevisionId: state.active_revision_id, resolution: "RESTORE_APPROVED", resolvedBy: "local-user", resolvedManifestHash: revision.manifest_hash, resolvedAt: now };
  }

  /**
   * Безопасное, немутующее перечитывание canonical manifest (для reconcile evidence).
   * Не создаёт candidate и не проверяет журнал; используется только внутри reconcile.
   */
  readCanonicalManifest(projectId: string): { manifestHash: string; manifest: readonly FileSnapshot[]; sourceHead: string; schemaVersion: number } {
    if (process.platform === "win32") throw this.unsupportedPlatformError();
    const result = captureRepository(this.repositoryRoot(projectId));
    return { manifestHash: result.manifestHash, manifest: result.manifest, sourceHead: result.sourceHead, schemaVersion: result.schemaVersion };
  }

  private onboardingDefaultBranch(projectId: string): string | undefined {
    const row = this.database.get<{ facts_json: string; proposed_json: string }>(
      "SELECT facts_json,proposed_json FROM onboarding_configs WHERE project_id=$projectId ORDER BY created_at DESC LIMIT 1",
      { projectId },
    );
    if (!row) return undefined;
    for (const source of [row.proposed_json, row.facts_json]) {
      try {
        const value = JSON.parse(source) as { defaultBranch?: unknown };
        if (typeof value.defaultBranch === "string") return value.defaultBranch;
      } catch { /* ignore malformed onboarding json */ }
    }
    return undefined;
  }

  private unsupportedPlatformError(): ProjectConfigError {
    return new ProjectConfigError("PROJECT_CONFIG_UNSUPPORTED_PLATFORM", "Project Config capture/write is disabled on Windows until safe file-handle verification is supported.");
  }

  private repositoryRoot(projectId: string): string {
    const path = this.repository.getRepositoryPath(projectId);
    if (!path) throw new ProjectConfigError("PROJECT_CONFIG_PROJECT_NOT_FOUND", "Project repository is unavailable.");
    try { return realpathSync(path); }
    catch { throw new ProjectConfigError("PROJECT_CONFIG_PROJECT_NOT_FOUND", "Project repository is unavailable."); }
  }
}

/** Проверяет Project Config integrity внутри scheduler-owned transaction перед dispatch. */
export function projectConfigDispatchAllowedTx(tx: DatabaseTx, projectId: string): boolean {
  if (!ProjectConfigRepository.hasLifecycleSchema(tx)) return true;
  const state = ProjectConfigRepository.readDispatchState(tx, projectId);
  if (!state) return true;
  if (state.config_status !== "READY") return false;
  if (ProjectConfigRepository.hasActiveJournalTx(tx, projectId)) return false;
  // После первого candidate Project уже участвует в lifecycle: до первого
  // точного approval нет authoritative snapshot для dispatch.
  if (!state.active_revision_id) return false;
  const row = ProjectConfigRepository.readApprovedRevision(tx, projectId, state.active_revision_id);
  if (!row || row.approval_status !== "APPROVED" || !revisionIntegrityValid(row)) return false;
  return true;
}

/** Выдаёт runtime только проверенный approved snapshot; отсутствие lifecycle state сохраняет legacy Project. */
export function approvedProjectConfigSnapshotTx(tx: DatabaseTx, projectId: string): { revisionId: string; revisionHash: string; config: ProjectConfigV1 } | undefined {
  const state = ProjectConfigRepository.readDispatchState(tx, projectId);
  if (!state) return undefined;
  if (state.config_status !== "READY" || !state.active_revision_id) throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Project Config has no approved active revision.");
  const revision = approvedProjectConfigRevisionTx(tx, projectId, state.active_revision_id);
  return { revisionId: revision.revisionId, revisionHash: revision.revisionHash, config: revision.config };
}

/** Повторно проверяет immutable revision при загрузке выданной run capability. */
export function approvedProjectConfigRevisionTx(tx: DatabaseTx, projectId: string, revisionId: string): { revisionId: string; revisionHash: string; config: ProjectConfigV1; files: Readonly<Record<string, string>> } {
  const row = ProjectConfigRepository.readApprovedRevision(tx, projectId, revisionId);
  if (!row || row.approval_status !== "APPROVED" || !revisionIntegrityValid(row)) {
    throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision failed integrity validation.");
  }
  const payload = JSON.parse(row.normalized_payload_json) as { project: unknown };
  return { revisionId: row.revision_id, revisionHash: row.revision_hash, config: parseProjectConfig(payload.project), files: revisionFromRow(row).files };
}

function captureRepository(root: string): CaptureResult {
  const directory = join(root, ".ebb-orchestrator");
  let directoryInfo;
  try { directoryInfo = lstatSync(directory); } catch { throw new ProjectConfigError("PROJECT_CONFIG_NOT_FOUND", "Canonical Project Config directory was not found."); }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config directory must be a regular directory.");
  assertCanonicalContainment(directory, root);
  const sourceHead = git(root, ["rev-parse", "HEAD"]).trim();
  const tracked = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ".ebb-orchestrator"]).split(/\r?\n/).filter(Boolean).filter(isAllowedPath);
  const files = new Map<string, Buffer>();
  walk(directory, root, files);
  if (!files.has(".ebb-orchestrator/project.yaml")) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config requires `.ebb-orchestrator/project.yaml`.");
  const sourceFiles: Record<string, string> = {};
  const snapshots: FileSnapshot[] = [];
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Project Config file is not valid UTF-8: ${path}`); }
    if (text.includes("\0")) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Project Config file contains binary data: ${path}`);
    sourceFiles[path] = bytes.toString("base64");
    snapshots.push({ path, state: "present", sha256: sha256(bytes) });
  }
  const currentPaths = new Set(files.keys());
  for (const path of tracked) if (!currentPaths.has(path)) snapshots.push({ path, state: "deleted", sha256: null });
  snapshots.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifestJson = JSON.stringify({ files: snapshots.map(({ path, state, sha256: digest }) => ({ path, state, sha256: digest })) });
  const manifestHash = hashDomain("ebb-project-config-manifest-v1\0", manifestJson);
  const projectYaml = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(sourceFiles[".ebb-orchestrator/project.yaml"]!, "base64"));
  let projectConfig;
  try { projectConfig = parseProjectConfigYaml(projectYaml); }
  catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config project.yaml failed schema validation."); }
  const normalizedPayload = { project: projectConfig, files: Object.fromEntries(Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b, "en"))) };
  return { sourceHead, manifest: snapshots, manifestJson, manifestHash, sourceFiles, normalizedPayload, schemaVersion: projectConfig.schema_version };
}

function walk(directory: string, root: string, output: Map<string, Buffer>): void {
  assertCanonicalContainment(directory, root);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const fullPath = join(directory, entry.name);
    const relativePath = relative(root, fullPath).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config cannot contain symlinks or reparse points.");
    assertCanonicalContainment(fullPath, root);
    if (entry.isDirectory()) {
      if (relativePath !== ".ebb-orchestrator/guidelines" && relativePath !== ".ebb-orchestrator/decisions") throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Unknown Project Config directory: ${relativePath}`);
      walk(fullPath, root, output);
      continue;
    }
    if (!entry.isFile() || !isAllowedPath(relativePath)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Unknown Project Config file: ${relativePath}`);
    if (output.size >= MAX_PROJECT_CONFIG_FILES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config exceeds the file count limit.");
    const bytes = readStableFile(fullPath, root);
    const totalBytes = [...output.values()].reduce((total, content) => total + content.length, 0) + bytes.length;
    if (totalBytes > MAX_PROJECT_CONFIG_TOTAL_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config exceeds the total size limit.");
    output.set(relativePath, bytes);
  }
  assertCanonicalContainment(directory, root);
}

function readStableFile(path: string, root: string): Buffer {
  assertCanonicalContainment(path, root);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config accepts regular files only.");
  if (before.size > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file changed during capture.");
    if (opened.size > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    assertCanonicalContainment(path, root);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== after.size) {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file changed during capture.");
    }
    if (bytes.length > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
    return bytes;
  } catch (cause) {
    if (cause instanceof ProjectConfigError) throw cause;
    throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config could not be read safely.");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function assertCanonicalContainment(path: string, root: string): void {
  try {
    const resolved = realpathSync.native(path);
    const configRoot = join(root, ".ebb-orchestrator");
    const within = relative(configRoot, resolved);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("outside canonical config root");
  } catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config path escapes its canonical directory or changed during capture."); }
}

function isAllowedPath(path: string): boolean {
  return path === ".ebb-orchestrator/project.yaml" || path === ".ebb-orchestrator/workflows.yaml"
    || /^\.ebb-orchestrator\/(?:guidelines|decisions)\/[^/]+\.md$/.test(path);
}
function git(root: string, args: string[]): string {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config provenance could not be verified against Git."); }
}
function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function hashDomain(domain: string, value: string): string { return createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex"); }
function canonicalJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, sortValue(entry)]));
}
function candidateFromRow(row: CandidateRow): ProjectConfigCandidate {
  const manifest = (JSON.parse(row.manifest_json) as { files: FileSnapshot[] }).files;
  const encodedFiles = JSON.parse(row.source_files_json) as Record<string, string>;
  const files = Object.fromEntries(Object.entries(encodedFiles).map(([path, bytes]) => [path, Buffer.from(bytes, "base64").toString("utf8")]));
  return { candidateId: row.candidate_id, projectId: row.project_id, sourceHead: row.source_head, manifest, manifestHash: row.manifest_hash, files, normalizedPreview: JSON.parse(row.normalized_payload_json) as Record<string, unknown>, status: row.status, createdAt: row.created_at };
}
function revisionFromRow(row: RevisionRow): ProjectConfigRevision {
  const manifest = (JSON.parse(row.manifest_json) as { files: FileSnapshot[] }).files;
  const encodedFiles = JSON.parse(row.source_files_json) as Record<string, string>;
  const files = Object.fromEntries(Object.entries(encodedFiles).map(([path, bytes]) => [path, Buffer.from(bytes, "base64").toString("utf8")]));
  return { revisionId: row.revision_id, candidateId: row.candidate_id, projectId: row.project_id, schemaVersion: row.schema_version, normalizedConfig: JSON.parse(row.normalized_payload_json) as Record<string, unknown>, manifestHash: row.manifest_hash, revisionHash: row.revision_hash, manifest, files, createdAt: row.created_at };
}

function candidateIntegrityValid(row: CandidateRow): boolean {
  try {
    if (!snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)) return false;
    const files = JSON.parse(row.source_files_json) as Record<string, string>;
    const projectYaml = Buffer.from(files[".ebb-orchestrator/project.yaml"]!, "base64").toString("utf8");
    const project = parseProjectConfigYaml(projectYaml);
    if (row.schema_version === 2) {
      const payload = JSON.parse(row.normalized_payload_json) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      if (typeof payload.expectedManifestHash !== "string" || typeof payload.baselineManifestHash !== "string" || !payload.baselineFiles || typeof payload.baselineFiles !== "object") return false;
      if (JSON.stringify(payload.files) !== JSON.stringify(files)) return false;
      return project.schema_version === 1;
    }
    const normalized = { project, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))) };
    return project.schema_version === row.schema_version && canonicalJson(normalized) === row.normalized_payload_json;
  } catch { return false; }
}

function snapshotIntegrityValid(manifestJson: string, sourceFilesJson: string, manifestHash: string): boolean {
  try {
    if (hashDomain("ebb-project-config-manifest-v1\0", manifestJson) !== manifestHash) return false;
    const parsedManifest = JSON.parse(manifestJson) as { files?: FileSnapshot[] };
    if (!parsedManifest || !Array.isArray(parsedManifest.files)) return false;
    const manifest = parsedManifest.files;
    const files = JSON.parse(sourceFilesJson) as Record<string, string>;
    const present = new Set<string>();
    for (const entry of manifest) {
      if (!isAllowedPath(entry.path) || (entry.state !== "present" && entry.state !== "deleted")) return false;
      if (entry.state === "deleted") {
        if (entry.sha256 !== null || files[entry.path] !== undefined) return false;
        continue;
      }
      const encoded = files[entry.path];
      if (typeof encoded !== "string") return false;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || sha256(bytes) !== entry.sha256) return false;
      present.add(entry.path);
    }
    return Object.keys(files).length === present.size && Object.keys(files).every((path) => present.has(path));
  } catch { return false; }
}

function revisionIntegrityValid(row: RevisionRow): boolean {
  try {
    const payload = JSON.parse(row.normalized_payload_json) as Record<string, unknown>;
    const project = parseProjectConfig(payload.project);
    const filesMatch = JSON.stringify(payload.files) === JSON.stringify(JSON.parse(row.source_files_json));
    const schemaOk = row.schema_version === 2 ? project.schema_version === 1 : project.schema_version === row.schema_version;
    return schemaOk
      && hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload)) === row.revision_hash
      && snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)
      && filesMatch;
  } catch { return false; }
}

// ── Project Config v2 editor / write journal helpers (plan-27 Task 4) ──

interface CandidateMeta {
  expectedManifestHash: string;
  baselineManifestHash: string;
  baselineFiles: Record<string, string>;
}

/** Итог reconcile, совпадающий с `journalReconcileResponseSchema`. */
interface JournalReconcileOutcome {
  journalId: string;
  projectId: string;
  phase: "RECONCILED_EXTERNAL" | "RECONCILED_RESTORED";
  configStatus: "READY";
  currentCandidateId: string;
  activeRevisionId: string | null;
  resolution: "ACCEPT_EXTERNAL" | "RESTORE_APPROVED";
  resolvedBy: string;
  resolvedManifestHash: string;
  resolvedAt: string;
}

function parseCandidateMeta(candidate: CandidateRow): CandidateMeta {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(candidate.normalized_payload_json) as Record<string, unknown>; }
  catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Editor candidate metadata is malformed."); }
  const expectedManifestHash = payload.expectedManifestHash;
  const baselineManifestHash = payload.baselineManifestHash;
  const baselineFiles = payload.baselineFiles;
  if (typeof expectedManifestHash !== "string" || typeof baselineManifestHash !== "string"
    || !baselineFiles || typeof baselineFiles !== "object" || Array.isArray(baselineFiles)) {
    throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Editor candidate metadata is incomplete.");
  }
  return { expectedManifestHash, baselineManifestHash, baselineFiles: baselineFiles as Record<string, string> };
}

/** YAML-скаляр с двойными кавычками (валиден для всех строк без управляющих символов). */
function yamlScalar(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config value contains control characters.");
  }
  return JSON.stringify(value);
}

/** Рендерит allowlisted файлы кандидата v2 из baseline capture и V2 settings. */
function renderProjectConfigV2Files(
  baseline: CaptureResult,
  settings: ReturnType<typeof parseProjectConfigV2>,
  targetBranch: string,
  expectedManifestHash: string,
): { files: Record<string, string>; manifestJson: string; manifestHash: string; payload: Record<string, unknown> } {
  const files: Record<string, string> = { ...baseline.sourceFiles };
  const projectYaml = `schema_version: 1\nproject:\n  name: ${yamlScalar(settings.projectDisplayName)}\n  default_branch: ${yamlScalar(targetBranch)}\n`;
  files[".ebb-orchestrator/project.yaml"] = Buffer.from(projectYaml, "utf8").toString("base64");
  const sortedFiles: Record<string, string> = {};
  for (const [path, encoded] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))) sortedFiles[path] = encoded;
  const snapshots: FileSnapshot[] = [];
  for (const [path, encoded] of Object.entries(sortedFiles)) {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file encoding is invalid.");
    snapshots.push({ path, state: "present", sha256: sha256(bytes) });
  }
  for (const snapshot of baseline.manifest) {
    if (snapshot.state === "deleted" && !sortedFiles[snapshot.path]) snapshots.push(snapshot);
  }
  snapshots.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifestJson = JSON.stringify({ files: snapshots.map(({ path, state, sha256: digest }) => ({ path, state, sha256: digest })) });
  const manifestHash = hashDomain("ebb-project-config-manifest-v1\0", manifestJson);
  const payload: Record<string, unknown> = {
    ...settings,
    project: { schema_version: 1, project: { name: settings.projectDisplayName, default_branch: targetBranch } },
    expectedManifestHash,
    baselineManifestHash: baseline.manifestHash,
    baselineFiles: baseline.sourceFiles,
    files: sortedFiles,
  };
  return { files: sortedFiles, manifestJson, manifestHash, payload };
}

/** Декодирует base64-мапу файлов из `source_files_json` в UTF-8 строки. */
function decodeFilesJson(json: string): Record<string, string> {
  const encoded = JSON.parse(json) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(encoded)) {
    const text = Buffer.from(value, "base64").toString("utf8");
    if (Buffer.from(text, "utf8").toString("base64") !== value) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file encoding mismatch.");
    out[path] = text;
  }
  return out;
}

function fileHashes(files: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) map.set(path, sha256(Buffer.from(text, "utf8")));
  return map;
}

/**
 * Безопасный (не-Windows) writer allowlisted `.ebb-orchestrator/` файлов.
 * Каждый путь проходит containment-проверку; финальный файл открывается с
 * O_NOFOLLOW и проверяется по дескриптору и пути. На Windows вызывается только
 * после доказательства native handle-протокола, которого в текущем окружении нет —
 * production gate остаётся fail-closed (PROJECT_CONFIG_UNSUPPORTED_PLATFORM).
 */
function writeProjectConfigFiles(root: string, files: Readonly<Record<string, string>>): void {
  const dir = join(root, ".ebb-orchestrator");
  assertCanonicalContainment(dir, root);
  for (const [relPath, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!isAllowedPath(relPath)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Non-allowlisted config file: ${relPath}`);
    const full = join(dir, relPath.slice(".ebb-orchestrator/".length));
    const parent = dirname(full);
    assertCanonicalContainment(parent, root);
    mkdirSync(parent, { recursive: true });
    const bytes = Buffer.from(text, "utf8");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    let fd: number | undefined;
    try {
      fd = openSync(full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o644);
      writeFileSync(fd, bytes);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size !== bytes.length) throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file verification failed after write.");
      const pathAfter = lstatSync(full);
      assertCanonicalContainment(full, root);
      if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.size !== bytes.length) {
        throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file identity changed during write.");
      }
    } catch (cause) {
      if (cause instanceof ProjectConfigError) throw cause;
      throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file could not be written safely.");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}

function revisionIdForCandidateTx(tx: DatabaseTx, projectId: string, candidateId: string): string | undefined {
  return tx.get<{ revision_id: string }>(
    "SELECT revision_id FROM project_config_revisions WHERE project_id=$projectId AND candidate_id=$candidateId ORDER BY created_at DESC, revision_id DESC LIMIT 1",
    { projectId, candidateId },
  )?.revision_id;
}

function existingResolutionOutcome(journal: ProjectConfigWriteJournalRecord, projectId: string, state: ProjectConfigStateRecord | undefined): JournalReconcileOutcome {
  if (journal.phase !== "RECONCILED_EXTERNAL" && journal.phase !== "RECONCILED_RESTORED") {
    throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Journal has no existing resolution.");
  }
  return {
    journalId: journal.id,
    projectId,
    phase: journal.phase,
    configStatus: "READY",
    currentCandidateId: state?.current_candidate_id ?? journal.candidate_id,
    activeRevisionId: state?.active_revision_id ?? null,
    resolution: journal.resolution as "ACCEPT_EXTERNAL" | "RESTORE_APPROVED",
    resolvedBy: journal.resolved_by ?? "local-user",
    resolvedManifestHash: journal.resolved_manifest_hash ?? "0".repeat(64),
    resolvedAt: journal.resolved_at ?? journal.updated_at,
  };
}
