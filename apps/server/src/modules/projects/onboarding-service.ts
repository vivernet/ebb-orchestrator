import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { OnboardingProjection, OnboardingProposal } from "@ebb-orchestrator/contracts";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { RepositoryDiscovery } from "./repository-discovery.js";
import type { RepositoryFacts } from "./repository-discovery.js";
import type { ApprovalTransactionPort } from "../approvals/approval-port.js";
import type { ApprovalStatus } from "../approvals/approval-types.js";

export interface Onboarding { readonly facts: RepositoryFacts; readonly onboardingStatus: "new" | "existing"; }
export interface OnboardingCommandService {
  discoverAndCreateDraft(repositoryPath: string): Promise<OnboardingProjection>;
  getProjection(projectId: string): OnboardingProjection | undefined;
  requestApproval(projectId: string, proposed: OnboardingProposal): OnboardingProjection;
  approve(projectId: string, note?: string): OnboardingProjection;
  activate(projectId: string): OnboardingProjection;
}

/** Ошибка onboarding с фиксированным machine-readable кодом для HTTP adapter. */
/** Ошибка command boundary с кодом, безопасным для versioned HTTP DTO. */
export class OnboardingError extends Error {
  constructor(readonly code: "ONBOARDING_INVALID_REPOSITORY" | "ONBOARDING_DISCOVERY_FAILED" | "ONBOARDING_NOT_FOUND" | "ONBOARDING_INVALID_PROPOSAL" | "ONBOARDING_APPROVAL_PENDING" | "ONBOARDING_NOT_PENDING" | "ONBOARDING_NOT_APPROVED", message: string) { super(message); }
}

interface OnboardingRow { project_id: string; repository_path: string; facts_json: string; proposed_json: string; status: "PROPOSED" | "ACTIVE"; approval_id: string | null; activated_at: string | null; }

/** Возвращает активные репозитории с точной привязкой утверждённого approval; при заданном projectId ограничивает результат этим проектом. */
export function listActiveApprovedOnboardingRepositories(database: Database, projectId?: string): Array<{ repository_path: string; proposed_json: string }> {
  return database.all(
    `SELECT oc.repository_path, oc.proposed_json FROM onboarding_configs oc
       JOIN approvals a ON a.id=oc.approval_id
      WHERE oc.status='ACTIVE' AND a.subject_type='PROJECT'
        AND a.subject_id=oc.project_id AND a.type='WORKFLOW_CHANGE'
        AND a.status='APPROVED' AND ($projectId IS NULL OR oc.project_id=$projectId)`,
    { projectId: projectId ?? null },
  );
}

/** Единственная command authority onboarding; routes не получают Database и approval SQL. */
export class OnboardingService implements OnboardingCommandService {
  constructor(private readonly database: Database, private readonly approvalPort: ApprovalTransactionPort, private readonly discovery = new RepositoryDiscovery()) {}

  async onboard(repoPath: string): Promise<Onboarding> { const facts = sanitizeFacts(await this.discovery.discover(repoPath)); return { facts, onboardingStatus: facts.untrustedExistingConfig ? "existing" : "new" }; }

  async discoverAndCreateDraft(repositoryPath: string): Promise<OnboardingProjection> {
    const path = validateRepositoryPath(repositoryPath);
    if (!path) throw new OnboardingError("ONBOARDING_INVALID_REPOSITORY", "Некорректный репозиторий.");
    let facts: RepositoryFacts;
    try { facts = sanitizeFacts(await this.discovery.discover(path)); } catch { throw new OnboardingError("ONBOARDING_DISCOVERY_FAILED", "Не удалось исследовать репозиторий."); }
    return this.database.transaction((tx) => {
      const now = new Date().toISOString(); const projectId = crypto.randomUUID(); const name = basename(facts.root) || "project";
      tx.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,$name,$displayName,'ACTIVE',$now,$now)", { id: projectId, name, displayName: name, now });
      tx.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$path,$facts,'null','PROPOSED',NULL,$now,$now)", { projectId, path: facts.root, facts: JSON.stringify(facts), now });
      return projectionFromTx(tx, projectId)!;
    });
  }

  getProjection(projectId: string): OnboardingProjection | undefined { return this.database.transaction((tx) => projectionFromTx(tx, projectId, false)); }

  requestApproval(projectId: string, proposed: OnboardingProposal): OnboardingProjection {
    validateProposal(proposed);
    return this.database.transaction((tx) => {
      const config = tx.get<OnboardingRow>("SELECT * FROM onboarding_configs WHERE project_id=$projectId", { projectId });
      if (!config) throw new OnboardingError("ONBOARDING_NOT_FOUND", "Онбординг не найден.");
      if (tx.get("SELECT id FROM approvals WHERE subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='PENDING'", { projectId })) throw new OnboardingError("ONBOARDING_APPROVAL_PENDING", "Запрос approval уже ожидает решения.");
      const approval = this.approvalPort.requestInTransaction(tx, { type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "local-user", metadata: { kind: "semantic-config", repositoryPath: config.repository_path, facts: JSON.parse(config.facts_json), proposed } });
      const now = new Date().toISOString();
      tx.run("UPDATE onboarding_configs SET proposed_json=$proposed,approval_id=$approvalId,status='PROPOSED',updated_at=$now,activated_at=NULL WHERE project_id=$projectId", { projectId, proposed: JSON.stringify(proposed), approvalId: approval.id, now });
      return projectionFromTx(tx, projectId)!;
    });
  }

  approve(projectId: string, note?: string): OnboardingProjection {
    return this.database.transaction((tx) => {
      const row = tx.get<{ id: string }>("SELECT id FROM approvals WHERE subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='PENDING' ORDER BY created_at DESC LIMIT 1", { projectId });
      if (!row) throw new OnboardingError("ONBOARDING_NOT_PENDING", "Онбординг не ожидает approval.");
      this.approvalPort.approveInTransaction(tx, { approvalId: row.id, subjectId: projectId, subjectType: "PROJECT", type: "WORKFLOW_CHANGE", actor: "local-user", note: note ?? null });
      tx.run("UPDATE onboarding_configs SET updated_at=$now WHERE project_id=$projectId AND status='PROPOSED' AND approval_id=$approvalId", { projectId, approvalId: row.id, now: new Date().toISOString() });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new OnboardingError("ONBOARDING_NOT_PENDING", "Не удалось обновить конфигурацию онбординга.");
      return projectionFromTx(tx, projectId)!;
    });
  }

  activate(projectId: string): OnboardingProjection {
    return this.database.transaction((tx) => {
      const config = tx.get<OnboardingRow>("SELECT * FROM onboarding_configs WHERE project_id=$projectId", { projectId });
      if (!config) throw new OnboardingError("ONBOARDING_NOT_APPROVED", "Онбординг не одобрен.");
      const approved = config.approval_id ? tx.get<{ id: string }>("SELECT id FROM approvals WHERE id=$id AND subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='APPROVED'", { id: config.approval_id, projectId }) : undefined;
      if (config.status === "ACTIVE" && approved) return projectionFromTx(tx, projectId)!;
      if (config.status !== "PROPOSED" || !approved) throw new OnboardingError("ONBOARDING_NOT_APPROVED", "Онбординг не одобрен.");
      const now = new Date().toISOString();
      tx.run("UPDATE onboarding_configs SET status='ACTIVE',updated_at=$now,activated_at=$now WHERE project_id=$projectId AND status='PROPOSED' AND approval_id=$approvalId AND EXISTS (SELECT 1 FROM approvals WHERE id=$approvalId AND subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='APPROVED')", { projectId, approvalId: config.approval_id, now });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new OnboardingError("ONBOARDING_NOT_APPROVED", "Онбординг не одобрен.");
      return projectionFromTx(tx, projectId)!;
    });
  }
}

function validateRepositoryPath(value: string): string | undefined { if (!value || !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) || value.includes("\0")) return undefined; try { const root = realpathSync(value); return statSync(root).isDirectory() ? root : undefined; } catch { return undefined; } }
function validateProposal(value: OnboardingProposal): void { if (!value || !value.defaultBranch || !value.workflow || !Array.isArray(value.roles) || !Array.isArray(value.guidelines) || value.roles.some((v) => !v) || value.guidelines.some((v) => !v)) throw new OnboardingError("ONBOARDING_INVALID_PROPOSAL", "Некорректное предложение onboarding."); }
function projectionFromTx(tx: DatabaseTx, projectId: string, throwIfMissing = true): OnboardingProjection | undefined {
  const project = tx.get<{ id: string }>("SELECT id FROM projects WHERE id=$projectId", { projectId }); const config = tx.get<OnboardingRow>("SELECT * FROM onboarding_configs WHERE project_id=$projectId", { projectId });
  if (!project || !config) { if (throwIfMissing) throw new OnboardingError("ONBOARDING_NOT_FOUND", "Онбординг не найден."); return undefined; }
  const facts = JSON.parse(config.facts_json) as RepositoryFacts; const proposed = JSON.parse(config.proposed_json) as OnboardingProposal | null;
  const approval = config.approval_id ? tx.get<{ id: string; status: ApprovalStatus }>("SELECT id,status FROM approvals WHERE id=$id AND subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE'", { id: config.approval_id, projectId }) : undefined;
  let status: OnboardingProjection["status"];
  if (config.status === "PROPOSED" && config.approval_id === null && config.proposed_json === "null") status = "DRAFT";
  else if (config.status === "PROPOSED" && proposed !== null && (approval?.status === "REJECTED" || approval?.status === "CANCELLED" || approval?.status === "CHANGES_REQUESTED")) status = "DRAFT";
  else if (config.status === "PROPOSED" && proposed !== null && approval?.status === "PENDING") status = "APPROVAL_PENDING";
  else if (config.status === "PROPOSED" && proposed !== null && approval?.status === "APPROVED") status = "APPROVED";
  else if (config.status === "ACTIVE" && proposed !== null && approval?.status === "APPROVED") status = "ACTIVE";
  else throw new Error("Persisted onboarding state is inconsistent");
  const remotes = facts.remotes.map((remote) => ({ name: remote.name, url: redactRemote(remote.url) }));
  const projectionApproval = approval && (approval.status === "PENDING" || approval.status === "APPROVED") ? { id: approval.id, status: approval.status } : null;
  return { contractVersion: 1, projectId, status, repository: { path: config.repository_path, remotes }, detected: { root: facts.root, defaultBranch: facts.defaultBranch, remotes, packageManager: facts.packageManager, languageHints: [...facts.languageHints], testCommands: [...facts.testCommands], untrustedExistingConfig: facts.untrustedExistingConfig }, proposed, approval: projectionApproval };
}
/** Удаляет credentials из обнаруженных remote до сохранения facts и approval metadata. */
function sanitizeFacts(facts: RepositoryFacts): RepositoryFacts {
  return { ...facts, remotes: facts.remotes.map((remote) => ({ name: remote.name, url: redactRemote(remote.url) })) };
}
function redactRemote(value: string): string { try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[redacted]"; } }
