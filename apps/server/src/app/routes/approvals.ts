import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ApprovalReadModel } from "../../modules/approvals/approval-read-model.js";
import { approvalInboxFilterSchema } from "@ebb-orchestrator/contracts";

export interface ApprovalCommandService {
  approve(id: string, actor: string, note?: string): unknown | Promise<unknown>;
  reject(id: string, actor: string, note?: string): unknown | Promise<unknown>;
  requestChanges(id: string, actor: string, note?: string): unknown | Promise<unknown>;
}
export interface ApprovalRouteDeps { db?: Database | undefined; approvalService?: ApprovalCommandService | undefined; }
function parseApprovalBody(value: unknown): { note?: string } | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "note")) return null;
  if (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 2000)) return null;
  return typeof record.note === "string" ? { note: record.note } : {};
}
function parseDecisionBody(value: unknown): { note?: string } | null {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "note")) return null;
  if (record.note !== undefined && (typeof record.note !== "string" || record.note.length > 2000)) return null;
  return typeof record.note === "string" ? { note: record.note } : {};
}
/**
 * Регистрирует HTTP-маршруты approvals и передаёт изменяющие состояние действия backend policy.
 */
export async function approvalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps = {}): Promise<void> {
  app.get<{ Querystring: { status?: string } }>("/api/v1/approvals", async (request, reply) => {
    const raw = request.query.status;
    let filter: "pending" | "resolved" = "pending";
    if (raw !== undefined) {
      const parsed = approvalInboxFilterSchema.safeParse(raw);
      if (!parsed.success) return reply.code(400).send({ error: "invalid status filter" });
      filter = parsed.data;
    }
    return new ApprovalReadModel(deps.db).listInbox(filter);
  });

  app.get("/api/v1/approvals/policies", async () => new ApprovalReadModel(deps.db).getPolicy());

  app.get<{ Params: { id: string } }>("/api/v1/approvals/:id", async (request, reply) => {
    const detail = new ApprovalReadModel(deps.db).getDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "approval not found" });
    return detail;
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/approvals/:id/approve", async (request, reply) => {
    if (!deps.approvalService) return reply.code(503).send({ error: "approval service unavailable" });
    const body = parseApprovalBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid approval body" });
    try {
      return await deps.approvalService.approve(request.params.id, "local-user", body.note);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) return reply.code(404).send({ error: "approval not found" });
      if (/already resolved|status/i.test(message)) return reply.code(409).send({ error: "approval is already resolved" });
      return reply.code(409).send({ error: "approval could not be resolved" });
    }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/approvals/:id/reject", async (request, reply) => {
    if (!deps.approvalService) return reply.code(503).send({ error: "approval service unavailable" });
    const body = parseDecisionBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid rejection body" });
    try {
      await deps.approvalService.reject(request.params.id, "local-user", body.note);
      return { status: "REJECTED" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) return reply.code(404).send({ error: "approval not found" });
      if (/already resolved|status/i.test(message)) return reply.code(409).send({ error: "approval is already resolved" });
      return reply.code(409).send({ error: "approval could not be resolved" });
    }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/approvals/:id/request-changes", async (request, reply) => {
    if (!deps.approvalService) return reply.code(503).send({ error: "approval service unavailable" });
    const body = parseDecisionBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid request-changes body" });
    try {
      await deps.approvalService.requestChanges(request.params.id, "local-user", body.note);
      return { status: "CHANGES_REQUESTED" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/not found/i.test(message)) return reply.code(404).send({ error: "approval not found" });
      if (/already resolved|status/i.test(message)) return reply.code(409).send({ error: "approval is already resolved" });
      return reply.code(409).send({ error: "approval could not be resolved" });
    }
  });
}
