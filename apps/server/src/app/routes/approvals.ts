import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
export interface ApprovalCommandService { approve(id: string, actor: string, note?: string): unknown | Promise<unknown>; }
export interface ApprovalRouteDeps { db?: Database | undefined; approvalService?: ApprovalCommandService | undefined; }
interface ApprovalRow { id: string; type: string; subject_id: string; subject_type: string; status: string; requested_by: string; resolved_by: string | null; resolution_note: string | null; created_at: string; resolved_at: string | null; }
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function approvalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps = {}): Promise<void> {
  app.get("/api/v1/approvals", async () => {
    if (!deps.db) return { approvals: [] };
     const rows = deps.db.all<ApprovalRow>("SELECT * FROM approvals WHERE status='PENDING' ORDER BY created_at");
    return { approvals: rows };
  });
  app.post<{ Params: { id: string }; Body?: { note?: string } }>("/api/v1/approvals/:id/approve", async (request, reply) => {
    if (!deps.approvalService) return reply.code(503).send({ error: "approval service unavailable" });
    const body = request.body ?? {};
    return deps.approvalService.approve(request.params.id, "local-user", body.note);
  });
}
