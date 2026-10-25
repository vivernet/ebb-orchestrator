import { randomUUID } from "node:crypto";
import type { Database, DatabaseTx } from "../../platform/database/database.js";

/** Определяет durable lifecycle state candidate, сохранённый в SQLite. */
export type ProjectConfigCandidateStatus = "PENDING_REVIEW" | "APPROVED_ACTIVE" | "STALE" | "SUPERSEDED";

/** Представляет сохранённый candidate для integrity-проверки application service. */
export interface ProjectConfigCandidateRecord {
  candidate_id: string;
  project_id: string;
  source_head: string;
  manifest_json: string;
  manifest_hash: string;
  source_files_json: string;
  normalized_payload_json: string;
  schema_version: number;
  status: ProjectConfigCandidateStatus;
  created_at: string;
}

/** Представляет неизменяемую revision и её provenance для application-level проверки. */
export interface ProjectConfigRevisionRecord {
  revision_id: string;
  project_id: string;
  candidate_id: string;
  schema_version: number;
  normalized_payload_json: string;
  source_head: string;
  manifest_json: string;
  source_files_json: string;
  manifest_hash: string;
  revision_hash: string;
  approval_id: string;
  created_at: string;
}

/** Представляет durable current/active pointers и состояние Project Config lifecycle. */
export interface ProjectConfigStateRecord {
  current_candidate_id: string | null;
  active_revision_id: string | null;
  config_status: "READY" | "DEGRADED";
}

/** Фазы журнала записи Project Config (plan-27 Task 4). */
export type ProjectConfigWriteJournalPhase =
  | "PREPARED" | "WRITING" | "APPLIED"
  | "DEGRADED" | "RECONCILED_EXTERNAL" | "RECONCILED_RESTORED";

/** Представляет durable журнал записи прикладных изменений Project Config. */
export interface ProjectConfigWriteJournalRecord {
  id: string;
  project_id: string;
  candidate_id: string;
  approval_id: string;
  expected_manifest_hash: string;
  old_files_json: string;
  new_files_json: string;
  phase: ProjectConfigWriteJournalPhase;
  failure_code: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_manifest_hash: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Описывает capture, подготовленный service до транзакционной записи candidate. */
export interface NewProjectConfigCandidate {
  projectId: string;
  sourceHead: string;
  manifestJson: string;
  manifestHash: string;
  sourceFilesJson: string;
  normalizedPayloadJson: string;
  schemaVersion: number;
}

/** Передаёт repository идентичность revision и одобренной записи, созданной service в его транзакции. */
export interface ProjectConfigApprovalWrite {
  revisionId: string;
  revisionHash: string;
  approvalId: string;
  createdAt: string;
}

/** Сигнализирует, что compare-and-set не завершился и вся approval transaction должна быть отменена. */
export class ProjectConfigRepositoryConflictError extends Error {
  constructor() {
    super("Project Config candidate or active revision changed during approval.");
    this.name = "ProjectConfigRepositoryConflictError";
  }
}

/** Хранит неизменяемые Project Config candidates, revision history и active pointer в SQLite. */
export class ProjectConfigRepository {
  /** Создаёт repository над общей SQLite connection, используемой approval и lifecycle transaction. */
  constructor(private readonly database: Database) {}

  /** Возвращает путь активного Project repository для последующего capture service-слоем. */
  getRepositoryPath(projectId: string): string | undefined {
    return this.database.get<{ repository_path: string }>(
      "SELECT o.repository_path FROM projects p JOIN onboarding_configs o ON o.project_id=p.id WHERE p.id=$projectId AND p.status='ACTIVE'",
      { projectId },
    )?.repository_path;
  }

  /**
   * Сохраняет candidate из уже завершённого service capture.
   * Одинаковый hash current candidate идемпотентен; иначе прежние pending candidates становятся `STALE`,
   * новый candidate и current pointer записываются одной SQLite-транзакцией, а active revision сохраняется.
   *
   * @param input Проверенный service-слоем snapshot с точными source bytes и вычисленными hash.
   * @returns Сохранённый текущий candidate, включая прежнюю запись при idempotent повторе.
   */
  capture(input: NewProjectConfigCandidate): ProjectConfigCandidateRecord {
    return this.database.transaction((tx) => {
      const state = tx.get<ProjectConfigStateRecord>("SELECT current_candidate_id,active_revision_id,config_status FROM project_config_state WHERE project_id=$projectId", { projectId: input.projectId });
      const current = state?.current_candidate_id
        ? tx.get<ProjectConfigCandidateRecord>("SELECT * FROM project_config_candidates WHERE candidate_id=$id AND project_id=$projectId", { id: state.current_candidate_id, projectId: input.projectId })
        : undefined;
      if (current?.manifest_hash === input.manifestHash && (current.status === "PENDING_REVIEW" || current.status === "APPROVED_ACTIVE")) return current;

      const candidateId = randomUUID();
      const now = new Date().toISOString();
      tx.run("UPDATE project_config_candidates SET status='STALE' WHERE project_id=$projectId AND status='PENDING_REVIEW'", { projectId: input.projectId });
      tx.run(
        `INSERT INTO project_config_candidates(candidate_id,project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,status,created_at)
         VALUES($candidateId,$projectId,$sourceHead,$manifestJson,$manifestHash,$sourceFilesJson,$normalizedPayloadJson,$schemaVersion,'PENDING_REVIEW',$now)`,
        { candidateId, projectId: input.projectId, sourceHead: input.sourceHead, manifestJson: input.manifestJson, manifestHash: input.manifestHash, sourceFilesJson: input.sourceFilesJson, normalizedPayloadJson: input.normalizedPayloadJson, schemaVersion: input.schemaVersion, now },
      );
      tx.run(
        `INSERT INTO project_config_state(project_id,current_candidate_id,active_revision_id,updated_at) VALUES($projectId,$candidateId,NULL,$now)
         ON CONFLICT(project_id) DO UPDATE SET current_candidate_id=excluded.current_candidate_id,updated_at=excluded.updated_at`,
        { projectId: input.projectId, candidateId, now },
      );
      return tx.get<ProjectConfigCandidateRecord>("SELECT * FROM project_config_candidates WHERE candidate_id=$candidateId", { candidateId })!;
    });
  }

  /** Читает только candidate, на который указывает Project Config state. */
  getCurrentCandidate(projectId: string): ProjectConfigCandidateRecord | undefined {
    return this.database.get<ProjectConfigCandidateRecord>(
      `SELECT c.* FROM project_config_state s JOIN project_config_candidates c ON c.candidate_id=s.current_candidate_id AND c.project_id=s.project_id
       WHERE s.project_id=$projectId`, { projectId },
    );
  }

  /** Читает candidate в заданной транзакции, ограничивая выборку Project и candidate ID. */
  getCandidate(projectId: string, candidateId: string, tx: DatabaseTx = this.database): ProjectConfigCandidateRecord | undefined {
    return tx.get<ProjectConfigCandidateRecord>("SELECT * FROM project_config_candidates WHERE candidate_id=$candidateId AND project_id=$projectId", { candidateId, projectId });
  }

  /** Читает current/active pointers и статус lifecycle в заданной транзакции. */
  getState(projectId: string, tx: DatabaseTx = this.database): ProjectConfigStateRecord | undefined {
    return tx.get<ProjectConfigStateRecord>("SELECT current_candidate_id,active_revision_id,config_status FROM project_config_state WHERE project_id=$projectId", { projectId });
  }

  /** Возвращает append-only историю revisions в порядке от новых к старым. */
  listRevisions(projectId: string): ProjectConfigRevisionRecord[] {
    return this.database.all<ProjectConfigRevisionRecord>("SELECT * FROM project_config_revisions WHERE project_id=$projectId ORDER BY created_at DESC,revision_id DESC", { projectId });
  }

  /**
   * Фиксирует explicit approval, append-only revision и active pointer в одной SQLite-транзакции.
   * Callback service-слоя повторно проверяет immutable candidate и создаёт approval через ApprovalService;
   * при несовпадении current candidate/hash возвращается `undefined`, а при сбое любого CAS-триггера
   * выбрасывается ошибка и SQLite откатывает все записи, включая approval из callback.
   *
   * @param projectId Владелец candidate и active revision.
   * @param candidateId Точный candidate, показанный пользователю для одобрения.
   * @param expectedManifestHash Hash snapshot, подтверждённый вместе с candidate ID.
   * @param createApproval Создаёт audit approval и revision identity в переданной общей транзакции.
   * @returns Созданная revision либо `undefined`, если candidate уже stale или не является текущим.
   */
  approveCandidate(
    projectId: string,
    candidateId: string,
    expectedManifestHash: string,
    createApproval: (tx: DatabaseTx, candidate: ProjectConfigCandidateRecord) => ProjectConfigApprovalWrite,
  ): ProjectConfigRevisionRecord | undefined {
    return this.database.transaction((tx) => {
      const state = this.getState(projectId, tx);
      const candidate = this.getCandidate(projectId, candidateId, tx);
      if (!state || state.current_candidate_id !== candidateId || !candidate || candidate.status !== "PENDING_REVIEW" || candidate.manifest_hash !== expectedManifestHash) return undefined;
      const write = createApproval(tx, candidate);
      tx.run(
        `INSERT INTO project_config_revisions(revision_id,project_id,candidate_id,schema_version,normalized_payload_json,source_head,manifest_json,source_files_json,manifest_hash,revision_hash,approval_id,created_at)
         VALUES($revisionId,$projectId,$candidateId,$schemaVersion,$payload,$sourceHead,$manifestJson,$sourceFilesJson,$manifestHash,$revisionHash,$approvalId,$now)`,
        { revisionId: write.revisionId, projectId, candidateId, schemaVersion: candidate.schema_version, payload: candidate.normalized_payload_json, sourceHead: candidate.source_head, manifestJson: candidate.manifest_json, sourceFilesJson: candidate.source_files_json, manifestHash: candidate.manifest_hash, revisionHash: write.revisionHash, approvalId: write.approvalId, now: write.createdAt },
      );
      if (state.active_revision_id) {
        tx.run("UPDATE project_config_candidates SET status='SUPERSEDED' WHERE candidate_id=(SELECT candidate_id FROM project_config_revisions WHERE revision_id=$revisionId) AND status='APPROVED_ACTIVE'", { revisionId: state.active_revision_id });
      }
      tx.run("UPDATE project_config_candidates SET status='APPROVED_ACTIVE' WHERE candidate_id=$candidateId AND project_id=$projectId AND status='PENDING_REVIEW'", { candidateId, projectId });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new ProjectConfigRepositoryConflictError();
      tx.run("UPDATE project_config_state SET active_revision_id=$revisionId,config_status='READY',updated_at=$now WHERE project_id=$projectId AND current_candidate_id=$candidateId AND active_revision_id IS $expectedRevision", { projectId, candidateId, revisionId: write.revisionId, expectedRevision: state.active_revision_id, now: write.createdAt });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new ProjectConfigRepositoryConflictError();
      return tx.get<ProjectConfigRevisionRecord>("SELECT * FROM project_config_revisions WHERE revision_id=$revisionId AND project_id=$projectId", { revisionId: write.revisionId, projectId });
    });
  }

  /**
   * Возвращает durable state и связанную approved revision вместе со статусом approval.
   * Состояние без active pointer возвращается без revision; отсутствующая связанная строка сохраняет pointer,
   * чтобы service мог пометить повреждённую конфигурацию как `DEGRADED` без fallback.
   *
   * @param projectId Идентификатор Project, чей runtime snapshot запрашивается.
   * @returns Состояние и найденная revision; отсутствие данных не трактуется как repository candidate.
   */
  getActiveRevision(projectId: string): { state: ProjectConfigStateRecord | undefined; revision: (ProjectConfigRevisionRecord & { approval_status: string }) | undefined } {
    const state = this.getState(projectId);
    if (!state?.active_revision_id) return { state, revision: undefined };
    const revision = this.database.get<ProjectConfigRevisionRecord & { approval_status: string }>(
      `SELECT r.*,a.status AS approval_status FROM project_config_state s
       JOIN project_config_revisions r ON r.revision_id=s.active_revision_id AND r.project_id=s.project_id
       JOIN approvals a ON a.id=r.approval_id AND a.subject_id=r.project_id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE'
       WHERE s.project_id=$projectId`, { projectId },
    );
    return { state, revision };
  }

  /**
   * Сохраняет fail-closed признак повреждённой active config для startup/runtime guards.
   *
   * @param projectId Идентификатор затронутого Project.
   * @param expectedActiveRevisionId Меняет статус только если проверенный active pointer всё ещё актуален.
   */
  markDegraded(projectId: string, expectedActiveRevisionId: string): void {
    this.database.run(
      "UPDATE project_config_state SET config_status='DEGRADED',updated_at=$now WHERE project_id=$projectId AND active_revision_id=$expectedActiveRevisionId",
      { projectId, expectedActiveRevisionId, now: new Date().toISOString() },
    );
  }

  /** Перечисляет Projects, чьи active revisions должны пройти startup integrity check. */
  listActiveProjectIds(): string[] {
    return this.database.all<{ project_id: string }>("SELECT project_id FROM project_config_state WHERE active_revision_id IS NOT NULL").map(({ project_id }) => project_id);
  }

  /**
   * Создаёт новый reviewable candidate из проверенной service-слоем исторической revision.
   * Staling history, candidate insert и current-pointer update сериализуются одной транзакцией;
   * активная revision не меняется, а исторический hash не реактивируется напрямую.
   *
   * @param projectId Project, которому принадлежит историческая revision.
   * @param revisionId Точная revision, которую service проверит до staging.
   * @param validate Выполняет integrity-проверки содержимого до любых записей.
   * @returns Новый current candidate либо `undefined`, если revision не существует/неподходящая.
   */
  stageRollback(projectId: string, revisionId: string, validate: (revision: ProjectConfigRevisionRecord) => boolean): ProjectConfigCandidateRecord | undefined {
    return this.database.transaction((tx) => {
      const revision = tx.get<ProjectConfigRevisionRecord>("SELECT * FROM project_config_revisions WHERE revision_id=$revisionId AND project_id=$projectId", { projectId, revisionId });
      const state = this.getState(projectId, tx);
      if (!revision || !state || state.active_revision_id === revisionId || !validate(revision)) return undefined;
      const current = state.current_candidate_id ? this.getCandidate(projectId, state.current_candidate_id, tx) : undefined;
      if (current?.manifest_hash === revision.manifest_hash && current.status === "PENDING_REVIEW") return current;
      const candidateId = randomUUID();
      const now = new Date().toISOString();
      tx.run("UPDATE project_config_candidates SET status='STALE' WHERE project_id=$projectId AND status='PENDING_REVIEW'", { projectId });
      tx.run(
        `INSERT INTO project_config_candidates(candidate_id,project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,status,created_at)
         VALUES($candidateId,$projectId,$sourceHead,$manifestJson,$manifestHash,$sourceFilesJson,$normalizedPayloadJson,$schemaVersion,'PENDING_REVIEW',$now)`,
        { candidateId, projectId, sourceHead: revision.source_head, manifestJson: revision.manifest_json, manifestHash: revision.manifest_hash, sourceFilesJson: revision.source_files_json, normalizedPayloadJson: revision.normalized_payload_json, schemaVersion: revision.schema_version, now },
      );
      tx.run("UPDATE project_config_state SET current_candidate_id=$candidateId,updated_at=$now WHERE project_id=$projectId", { projectId, candidateId, now });
      return tx.get<ProjectConfigCandidateRecord>("SELECT * FROM project_config_candidates WHERE candidate_id=$candidateId", { candidateId });
    });
  }

  /** Читает lifecycle state внутри внешней scheduler/runtime-транзакции. */
  static readDispatchState(tx: DatabaseTx, projectId: string): ProjectConfigStateRecord | undefined {
    return tx.get<ProjectConfigStateRecord>("SELECT current_candidate_id,active_revision_id,config_status FROM project_config_state WHERE project_id=$projectId", { projectId });
  }

  /** Сохраняет совместимость старой схемы, где Project Config lifecycle ещё отсутствует. */
  static hasLifecycleSchema(tx: DatabaseTx): boolean {
    return tx.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='project_config_state'") !== undefined;
  }

  /** Читает approved revision и статус связанного approval в вызывающей транзакции. */
  static readApprovedRevision(tx: DatabaseTx, projectId: string, revisionId: string): ProjectConfigRevisionRecord & { approval_status: string } | undefined {
    return tx.get<ProjectConfigRevisionRecord & { approval_status: string }>(
      `SELECT r.*,a.status AS approval_status FROM project_config_revisions r
       JOIN approvals a ON a.id=r.approval_id AND a.subject_id=r.project_id AND a.subject_type='PROJECT' AND a.type='WORKFLOW_CHANGE'
       WHERE r.project_id=$projectId AND r.revision_id=$revisionId`, { projectId, revisionId },
    );
  }

  // ── Project Config write journal (plan-27 Task 4) ──────────────────────

  /** Возвращает активный (non-terminal) журнал записи проекта, если он есть. */
  getActiveJournal(projectId: string): ProjectConfigWriteJournalRecord | undefined {
    const table = this.database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='project_config_write_journal'");
    if (!table) return undefined;
    return this.database.get<ProjectConfigWriteJournalRecord>(
      `SELECT * FROM project_config_write_journal
       WHERE project_id=$projectId AND phase IN ('PREPARED','WRITING','DEGRADED')
       ORDER BY created_at DESC, id DESC LIMIT 1`, { projectId },
    );
  }

  /** Возвращает все журналы проекта от новых к старым. */
  listJournals(projectId: string): ProjectConfigWriteJournalRecord[] {
    return this.database.all<ProjectConfigWriteJournalRecord>(
      "SELECT * FROM project_config_write_journal WHERE project_id=$projectId ORDER BY created_at DESC, id DESC", { projectId },
    );
  }

  /** Проверяет наличие активного журнала внутри вызывающей транзакции (dispatch gate). */
  static hasActiveJournalTx(tx: DatabaseTx, projectId: string): boolean {
    if (!tx.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='project_config_write_journal'")) return false;
    return Boolean(tx.get(
      "SELECT 1 FROM project_config_write_journal WHERE project_id=$projectId AND phase IN ('PREPARED','WRITING','DEGRADED') LIMIT 1",
      { projectId },
    ));
  }

  /**
   * Фиксирует exact-hash approval и immutable revision БЕЗ активации: candidate
   * остаётся `PENDING_REVIEW`, `active_revision_id` не меняется. Журнал создаётся
   * отдельно тем же сервисом; активация происходит только после проверенной записи
   * файлов (applyJournalTx).
   */
  approvePreparedCandidate(
    projectId: string,
    candidateId: string,
    expectedManifestHash: string,
    createApproval: (tx: DatabaseTx, candidate: ProjectConfigCandidateRecord) => ProjectConfigApprovalWrite,
  ): { revision: ProjectConfigRevisionRecord; candidate: ProjectConfigCandidateRecord } | undefined {
    return this.database.transaction((tx) => {
      const state = this.getState(projectId, tx);
      const candidate = this.getCandidate(projectId, candidateId, tx);
      if (!state || state.current_candidate_id !== candidateId || !candidate || candidate.status !== "PENDING_REVIEW" || candidate.manifest_hash !== expectedManifestHash) return undefined;
      const write = createApproval(tx, candidate);
      tx.run(
        `INSERT INTO project_config_revisions(revision_id,project_id,candidate_id,schema_version,normalized_payload_json,source_head,manifest_json,source_files_json,manifest_hash,revision_hash,approval_id,created_at)
         VALUES($revisionId,$projectId,$candidateId,$schemaVersion,$payload,$sourceHead,$manifestJson,$sourceFilesJson,$manifestHash,$revisionHash,$approvalId,$now)`,
        { revisionId: write.revisionId, projectId, candidateId, schemaVersion: candidate.schema_version, payload: candidate.normalized_payload_json, sourceHead: candidate.source_head, manifestJson: candidate.manifest_json, sourceFilesJson: candidate.source_files_json, manifestHash: candidate.manifest_hash, revisionHash: write.revisionHash, approvalId: write.approvalId, now: write.createdAt },
      );
      const revision = tx.get<ProjectConfigRevisionRecord>("SELECT * FROM project_config_revisions WHERE revision_id=$revisionId AND project_id=$projectId", { revisionId: write.revisionId, projectId });
      if (!revision) return undefined;
      return { revision, candidate };
    });
  }

  /** Создаёт журнал в фазе PREPARED внутри вызывающей транзакции. */
  createJournalInTransaction(tx: DatabaseTx, input: {
    id: string; projectId: string; candidateId: string; approvalId: string;
    expectedManifestHash: string; oldFilesJson: string; newFilesJson: string; now: string;
  }): void {
    tx.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,created_at,updated_at)
       VALUES($id,$projectId,$candidateId,$approvalId,$expectedManifestHash,$oldFilesJson,$newFilesJson,'PREPARED',$now,$now)`,
      input,
    );
  }

  /** Помечает фазу журнала (CAS): только предсказуемый переход фазы фиксируется. */
  updateJournalPhase(journalId: string, expectedPhase: ProjectConfigWriteJournalPhase, phase: ProjectConfigWriteJournalPhase, now: string, failureCode?: string): boolean {
    return this.database.transaction((tx) => {
      tx.run(
        "UPDATE project_config_write_journal SET phase=$phase,failure_code=$failureCode,updated_at=$now WHERE id=$id AND phase=$expectedPhase",
        { id: journalId, phase, expectedPhase, failureCode: failureCode ?? null, now },
      );
      return tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes === 1;
    });
  }

  /** Помечает журнал DEGRADED и состояние проекта DEGRADED (CAS по фазе). */
  markJournalDegraded(journalId: string, projectId: string, failureCode: string, now: string): boolean {
    return this.database.transaction((tx) => {
      tx.run(
        "UPDATE project_config_write_journal SET phase='DEGRADED',failure_code=$failureCode,updated_at=$now WHERE id=$id AND phase IN ('PREPARED','WRITING')",
        { id: journalId, failureCode, now },
      );
      const journalChanged = tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes === 1;
      if (journalChanged) {
        tx.run("UPDATE project_config_state SET config_status='DEGRADED',updated_at=$now WHERE project_id=$projectId", { projectId, now });
      }
      return journalChanged;
    });
  }

  /** Терминальная фаза reconcile: CAS по DEGRADED и незаполненной resolution. */
  closeJournalReconciledTx(tx: DatabaseTx, journalId: string, input: {
    resolution: "ACCEPT_EXTERNAL" | "RESTORE_APPROVED";
    resolvedBy: string; resolvedManifestHash: string; resolvedAt: string;
  }): boolean {
    tx.run(
      `UPDATE project_config_write_journal
       SET phase=$phase,resolution=$resolution,resolved_by=$resolvedBy,resolved_manifest_hash=$resolvedManifestHash,resolved_at=$resolvedAt,updated_at=$resolvedAt
       WHERE id=$id AND phase='DEGRADED' AND resolved_manifest_hash IS NULL`,
      { id: journalId, phase: input.resolution === "ACCEPT_EXTERNAL" ? "RECONCILED_EXTERNAL" : "RECONCILED_RESTORED", ...input },
    );
    return tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes === 1;
  }

  /** Обновляет current candidate указатель и сбрасывает config_status в READY. */
  setCurrentCandidateTx(tx: DatabaseTx, projectId: string, candidateId: string, now: string): void {
    tx.run(
      "UPDATE project_config_state SET current_candidate_id=$candidateId,config_status='READY',updated_at=$now WHERE project_id=$projectId",
      { projectId, candidateId, now },
    );
  }

  /**
   * Единственная транзакция применения: journal APPLIED + candidate APPROVED_ACTIVE
   * + advance active revision. Прежняя active revision остаётся authoritative до
   * этого commit; CAS-сбой откатывает всё.
   */
  applyJournalTx(tx: DatabaseTx, journalId: string, projectId: string, candidateId: string, revisionId: string, expectedActiveRevisionId: string | null, now: string): boolean {
    tx.run(
      "UPDATE project_config_write_journal SET phase='APPLIED',updated_at=$now WHERE id=$id AND phase IN ('PREPARED','WRITING')",
      { id: journalId, now },
    );
    if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return false;
    tx.run(
      "UPDATE project_config_candidates SET status='APPROVED_ACTIVE' WHERE candidate_id=$candidateId AND project_id=$projectId AND status='PENDING_REVIEW'",
      { candidateId, projectId },
    );
    if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return false;
    tx.run(
      `UPDATE project_config_state SET active_revision_id=$revisionId,config_status='READY',updated_at=$now
       WHERE project_id=$projectId AND current_candidate_id=$candidateId AND active_revision_id IS $expectedActiveRevision`,
      { projectId, candidateId, revisionId, expectedActiveRevision: expectedActiveRevisionId, now },
    );
    return tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes === 1;
  }
}
