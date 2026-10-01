import { randomUUID } from "node:crypto";
import type { Database, DatabaseTx } from "../../platform/database/database.js";

export type HumanFeedbackStatus = "UNTRIAGED" | "LINKED" | "IGNORED" | "RESOLVED" | "DELETED";
export type FeedbackDeliveryResult = "DELIVERED" | "UNMAPPED";
export interface IssueCommentInput {
  readonly repository: string;
  readonly commentId: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly authorType: string;
  readonly sourceUrl: string;
  readonly sourceCreatedAt: string | null;
  readonly sourceUpdatedAt: string | null;
}
export interface HumanFeedbackItem {
  readonly id: string;
  readonly projectId: string;
  readonly sourceKey: string;
  readonly sourceRepository: string;
  readonly sourceIssueNumber: number;
  readonly sourceCommentId: number;
  readonly authorLogin: string;
  readonly authorType: string;
  readonly body: string;
  readonly sourceUrl: string;
  readonly sourceCreatedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly receivedAt: string;
  readonly status: HumanFeedbackStatus;
  readonly taskId: string | null;
  readonly epicId: string | null;
  readonly triagedAt: string | null;
}
export interface HumanFeedbackPage { readonly items: HumanFeedbackItem[]; readonly nextCursor: string | null; }
interface FeedbackRow {
  id: string; project_id: string; source_key: string; source_repository: string; source_issue_number: number; source_comment_id: number;
  author_login: string; author_type: string; body: string; source_url: string; source_created_at: string | null; source_updated_at: string | null;
  received_at: string; status: HumanFeedbackStatus; task_id: string | null; epic_id: string | null; triaged_at: string | null;
}

/** Представляет безопасную доменную ошибку mapping или Project-scoped triage. */
export class HumanFeedbackError extends Error {
  constructor(readonly code: "FEEDBACK_PROJECT_NOT_FOUND" | "FEEDBACK_MAPPING_INVALID" | "FEEDBACK_MAPPING_CONFLICT" | "FEEDBACK_CURSOR_INVALID" | "FEEDBACK_NOT_FOUND" | "FEEDBACK_ALREADY_TRIAGED" | "FEEDBACK_TARGET_NOT_FOUND", message: string) {
    super(message);
    this.name = "HumanFeedbackError";
  }
}

/** Владеет только Project mapping, durable inbox/dedupe и локальными triage transitions. */
export class HumanFeedbackService {
  constructor(private readonly database: Database) {}

  /** Сохраняет явную привязку GitHub repository к одному active Project. */
  setMapping(projectId: string, repository: string): void {
    const repositoryKey = normalizeRepository(repository);
    this.database.transaction((tx) => {
      const project = tx.get<{ id: string }>("SELECT id FROM projects WHERE id=$projectId AND status='ACTIVE'", { projectId });
      if (!project) throw new HumanFeedbackError("FEEDBACK_PROJECT_NOT_FOUND", "Активный проект не найден.");
      const conflict = tx.get<{ project_id: string }>("SELECT project_id FROM github_project_mappings WHERE repository_key=$repository", { repository: repositoryKey });
      if (conflict && conflict.project_id !== projectId) throw new HumanFeedbackError("FEEDBACK_MAPPING_CONFLICT", "Этот GitHub repository уже связан с другим проектом.");
      const now = new Date().toISOString();
      tx.run("DELETE FROM github_project_mappings WHERE project_id=$projectId AND repository_key<>$repository", { projectId, repository: repositoryKey });
      tx.run(
        `INSERT INTO github_project_mappings(repository_key,project_id,created_at,updated_at) VALUES($repository,$projectId,$now,$now)
         ON CONFLICT(repository_key) DO UPDATE SET project_id=excluded.project_id,updated_at=excluded.updated_at`,
        { repository: repositoryKey, projectId, now },
      );
    });
  }

  /** Удаляет mapping, не перенося и не удаляя уже полученные feedback rows. */
  removeMapping(projectId: string): void { this.database.run("DELETE FROM github_project_mappings WHERE project_id=$projectId", { projectId }); }

  getMapping(projectId: string): string | undefined {
    return this.database.get<{ repository_key: string }>("SELECT repository_key FROM github_project_mappings WHERE project_id=$projectId", { projectId })?.repository_key;
  }

  listMappedRepositories(): string[] {
    return this.database.all<{ repository_key: string }>("SELECT m.repository_key FROM github_project_mappings m JOIN projects p ON p.id=m.project_id WHERE p.status='ACTIVE' ORDER BY m.repository_key").map((row) => row.repository_key);
  }

  /** Одной транзакцией записывает inbox item и delivered receipt; unmapped comment не оставляет receipt. */
  receiveComment(input: IssueCommentInput): FeedbackDeliveryResult {
    const repository = normalizeRepository(input.repository);
    validateComment(input);
    const sourceKey = `github.com:${repository}:issue-comment:${input.commentId}`;
    return this.database.transaction((tx) => {
      const mapping = tx.get<{ project_id: string }>(
        `SELECT m.project_id FROM github_project_mappings m JOIN projects p ON p.id=m.project_id
          WHERE m.repository_key=$repository AND p.status='ACTIVE'`, { repository },
      );
      if (!mapping) return "UNMAPPED";
      const duplicate = tx.get<{ id: string }>("SELECT id FROM human_feedback WHERE source_key=$sourceKey", { sourceKey });
      if (!duplicate) {
        const now = new Date().toISOString();
        tx.run(
          `INSERT INTO human_feedback(id,project_id,source_key,source_repository,source_issue_number,source_comment_id,author_login,author_type,body,source_url,source_created_at,source_updated_at,received_at,status)
           VALUES($id,$projectId,$sourceKey,$repository,$issueNumber,$commentId,$authorLogin,$authorType,$body,$sourceUrl,$sourceCreatedAt,$sourceUpdatedAt,$receivedAt,'UNTRIAGED')`,
          { id: randomUUID(), projectId: mapping.project_id, sourceKey, repository, issueNumber: input.issueNumber, commentId: input.commentId, authorLogin: input.authorLogin, authorType: input.authorType, body: input.body, sourceUrl: input.sourceUrl, sourceCreatedAt: input.sourceCreatedAt, sourceUpdatedAt: input.sourceUpdatedAt, receivedAt: now },
        );
      }
      const now = new Date().toISOString();
      tx.run(
        `INSERT INTO github_feedback_deliveries(repository,comment_id,issue_number,status,created_at,delivered_at)
         VALUES($repository,$commentId,$issueNumber,'DELIVERED',$now,$now)
         ON CONFLICT(repository,comment_id) DO UPDATE SET issue_number=excluded.issue_number,status='DELIVERED',delivered_at=excluded.delivered_at`,
        { repository, commentId: input.commentId, issueNumber: input.issueNumber, now },
      );
      return "DELIVERED";
    });
  }

  /** Возвращает только записи выбранного Project и status, никогда не включает deleted tombstones по умолчанию. */
  list(projectId: string, status: HumanFeedbackStatus = "UNTRIAGED"): HumanFeedbackItem[] {
    return this.listPage(projectId, status).items;
  }

  /** Читает стабильную страницу inbox только выбранного Project/status с opaque keyset cursor. */
  listPage(projectId: string, status: HumanFeedbackStatus = "UNTRIAGED", cursor?: string): HumanFeedbackPage {
    if (!isStatus(status)) throw new HumanFeedbackError("FEEDBACK_MAPPING_INVALID", "Недопустимый статус inbox.");
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    const rows = this.database.all<FeedbackRow>(
      `SELECT * FROM human_feedback WHERE project_id=$projectId AND status=$status
       AND ($receivedAt IS NULL OR received_at<$receivedAt OR (received_at=$receivedAt AND id<$cursorId))
       ORDER BY received_at DESC,id DESC LIMIT 101`,
      { projectId, status, receivedAt: position?.receivedAt ?? null, cursorId: position?.id ?? null },
    );
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return { items: page.map(toItem), nextCursor: rows.length > 100 && last ? encodeCursor(last.received_at, last.id) : null };
  }

  /** Связывает inbox item только с Task/Epic того же Project. */
  link(projectId: string, feedbackId: string, targetType: "TASK" | "EPIC", targetId: string): HumanFeedbackItem {
    return this.triage(projectId, feedbackId, (tx) => {
      const table = targetType === "TASK" ? "tasks" : "epics";
      const target = tx.get<{ id: string }>(`SELECT id FROM ${table} WHERE id=$targetId AND project_id=$projectId`, { targetId, projectId });
      if (!target) throw new HumanFeedbackError("FEEDBACK_TARGET_NOT_FOUND", "Элемент проекта не найден.");
      const now = new Date().toISOString();
      tx.run("UPDATE human_feedback SET status='LINKED',task_id=$taskId,epic_id=$epicId,triaged_at=$now WHERE id=$id AND project_id=$projectId AND status='UNTRIAGED'", { id: feedbackId, projectId, taskId: targetType === "TASK" ? targetId : null, epicId: targetType === "EPIC" ? targetId : null, now });
      return now;
    });
  }

  ignore(projectId: string, feedbackId: string): HumanFeedbackItem { return this.setTerminalStatus(projectId, feedbackId, "IGNORED"); }
  resolve(projectId: string, feedbackId: string): HumanFeedbackItem { return this.setTerminalStatus(projectId, feedbackId, "RESOLVED"); }

  /** Удаляет тело и личные metadata, сохраняя минимальный source identity tombstone от повторного импорта. */
  delete(projectId: string, feedbackId: string): HumanFeedbackItem {
    const now = new Date().toISOString();
    return this.database.transaction((tx) => {
      const existing = tx.get<FeedbackRow>("SELECT * FROM human_feedback WHERE id=$id AND project_id=$projectId", { id: feedbackId, projectId });
      if (!existing) throw new HumanFeedbackError("FEEDBACK_NOT_FOUND", "Запись inbox не найдена.");
      if (existing.status !== "DELETED") tx.run(
        `UPDATE human_feedback SET author_login='',author_type='',body='',source_url='',source_created_at=NULL,source_updated_at=NULL,status='DELETED',task_id=NULL,epic_id=NULL,triaged_at=$now,deleted_at=$now
          WHERE id=$id AND project_id=$projectId AND status<>'DELETED'`, { id: feedbackId, projectId, now },
      );
      return toItem(tx.get<FeedbackRow>("SELECT * FROM human_feedback WHERE id=$id AND project_id=$projectId", { id: feedbackId, projectId })!);
    });
  }

  private setTerminalStatus(projectId: string, feedbackId: string, status: "IGNORED" | "RESOLVED"): HumanFeedbackItem {
    return this.triage(projectId, feedbackId, (tx) => {
      const now = new Date().toISOString();
      tx.run("UPDATE human_feedback SET status=$status,triaged_at=$now WHERE id=$id AND project_id=$projectId AND status='UNTRIAGED'", { id: feedbackId, projectId, status, now });
      return now;
    });
  }

  private triage(projectId: string, feedbackId: string, update: (tx: DatabaseTx) => string): HumanFeedbackItem {
    return this.database.transaction((tx) => {
      const row = tx.get<FeedbackRow>("SELECT * FROM human_feedback WHERE id=$id AND project_id=$projectId", { id: feedbackId, projectId });
      if (!row) throw new HumanFeedbackError("FEEDBACK_NOT_FOUND", "Запись inbox не найдена.");
      if (row.status !== "UNTRIAGED") throw new HumanFeedbackError("FEEDBACK_ALREADY_TRIAGED", "Запись inbox уже обработана.");
      update(tx);
      return toItem(tx.get<FeedbackRow>("SELECT * FROM human_feedback WHERE id=$id AND project_id=$projectId", { id: feedbackId, projectId })!);
    });
  }
}

/** Нормализует GitHub owner/repository для уникального локального mapping. */
export function normalizeRepository(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(normalized) || normalized.endsWith(".git")) {
    throw new HumanFeedbackError("FEEDBACK_MAPPING_INVALID", "Ожидается GitHub repository в форме owner/repository.");
  }
  return normalized;
}
function validateComment(input: IssueCommentInput): void {
  if (!Number.isSafeInteger(input.commentId) || input.commentId < 1 || !Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1 || typeof input.body !== "string" || typeof input.authorLogin !== "string" || typeof input.authorType !== "string" || typeof input.sourceUrl !== "string") {
    throw new HumanFeedbackError("FEEDBACK_MAPPING_INVALID", "GitHub comment DTO is invalid.");
  }
  try {
    const url = new URL(input.sourceUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) throw new Error("invalid source URL");
  } catch { throw new HumanFeedbackError("FEEDBACK_MAPPING_INVALID", "GitHub comment URL is invalid."); }
}
function isStatus(value: string): value is HumanFeedbackStatus { return ["UNTRIAGED", "LINKED", "IGNORED", "RESOLVED", "DELETED"].includes(value); }
function encodeCursor(receivedAt: string, id: string): string { return Buffer.from(JSON.stringify({ receivedAt, id }), "utf8").toString("base64url"); }
function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  try {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor encoding");
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("noncanonical cursor encoding");
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt)) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) throw new Error("invalid cursor payload");
    return { receivedAt: value.receivedAt, id: value.id };
  } catch { throw new HumanFeedbackError("FEEDBACK_CURSOR_INVALID", "Недопустимый cursor inbox."); }
}
function toItem(row: FeedbackRow): HumanFeedbackItem {
  return { id: row.id, projectId: row.project_id, sourceKey: row.source_key, sourceRepository: row.source_repository, sourceIssueNumber: row.source_issue_number, sourceCommentId: row.source_comment_id, authorLogin: row.author_login, authorType: row.author_type, body: row.body, sourceUrl: row.source_url, sourceCreatedAt: row.source_created_at, sourceUpdatedAt: row.source_updated_at, receivedAt: row.received_at, status: row.status, taskId: row.task_id, epicId: row.epic_id, triagedAt: row.triaged_at };
}
