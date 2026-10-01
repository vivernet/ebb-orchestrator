import type { FastifyInstance } from "fastify";
import { HumanFeedbackError, type HumanFeedbackService, type HumanFeedbackStatus } from "../../modules/github/human-feedback-service.js";
import type { GitHubSyncWorker } from "../../modules/github/github-sync-worker.js";

export interface HumanFeedbackRouteDeps { service?: HumanFeedbackService; worker?: GitHubSyncWorker; }

/** Защищённые Project-scoped adapters для GitHub mapping, Sync now и HumanFeedback triage. */
export async function humanFeedbackRoutes(app: FastifyInstance, deps: HumanFeedbackRouteDeps = {}): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { status?: string; cursor?: string } }>("/api/v1/projects/:projectId/human-feedback", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
    const status = request.query.status ?? "UNTRIAGED";
    if (!isStatus(status)) return reply.code(400).send({ error: "invalid feedback status" });
    try { return reply.send(deps.service.listPage(request.params.projectId, status, request.query.cursor)); }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/github/mapping", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
    return reply.send({ repository: deps.service.getMapping(request.params.projectId) ?? null });
  });

  app.put<{ Params: { projectId: string }; Body: unknown }>("/api/v1/projects/:projectId/github/mapping", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
    const repository = parseRepositoryBody(request.body);
    if (!repository) return reply.code(400).send({ error: "expected repository owner/name" });
    try { deps.service.setMapping(request.params.projectId, repository); return reply.send({ repository: deps.service.getMapping(request.params.projectId) }); }
    catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { projectId: string }; Body: unknown }>("/api/v1/projects/:projectId/github/mapping", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
    if (request.body !== undefined && !isEmptyObject(request.body)) return reply.code(400).send({ error: "request body must be empty" });
    deps.service.removeMapping(request.params.projectId);
    return reply.code(204).send();
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/v1/projects/:projectId/github/sync", async (request, reply) => {
    if (!deps.service || !deps.worker) return reply.code(503).send({ error: "GitHub sync is unavailable" });
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: "request body must be empty" });
    const repository = deps.service.getMapping(request.params.projectId);
    if (!repository) return reply.code(409).send({ status: "SYNC_PENDING", reason: "PROJECT_MAPPING_REQUIRED" });
    return reply.send({ status: await deps.worker.syncIssues(repository) });
  });

  app.post<{ Params: { projectId: string; feedbackId: string }; Body: unknown }>("/api/v1/projects/:projectId/human-feedback/:feedbackId/link", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
    const body = parseLinkBody(request.body);
    if (!body) return reply.code(400).send({ error: "expected TASK or EPIC target" });
    try { return reply.send({ item: deps.service.link(request.params.projectId, request.params.feedbackId, body.targetType, body.targetId) }); }
    catch (error) { return sendError(reply, error); }
  });

  for (const [action, apply] of [
    ["ignore", (projectId: string, itemId: string) => deps.service!.ignore(projectId, itemId)],
    ["resolve", (projectId: string, itemId: string) => deps.service!.resolve(projectId, itemId)],
    ["delete", (projectId: string, itemId: string) => deps.service!.delete(projectId, itemId)],
  ] as const) {
    app.post<{ Params: { projectId: string; feedbackId: string }; Body: unknown }>(`/api/v1/projects/:projectId/human-feedback/:feedbackId/${action}`, async (request, reply) => {
      if (!deps.service) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
      if (!isEmptyObject(request.body)) return reply.code(400).send({ error: "request body must be empty" });
      try { return reply.send({ item: apply(request.params.projectId, request.params.feedbackId) }); }
      catch (error) { return sendError(reply, error); }
    });
  }
}

function parseRepositoryBody(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && Object.keys(body)[0] === "repository" && typeof body.repository === "string" ? body.repository : undefined;
}
function parseLinkBody(value: unknown): { targetType: "TASK" | "EPIC"; targetId: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 2 && (body.targetType === "TASK" || body.targetType === "EPIC") && typeof body.targetId === "string" && body.targetId.length > 0
    ? { targetType: body.targetType, targetId: body.targetId } : undefined;
}
function isStatus(value: string): value is HumanFeedbackStatus { return ["UNTRIAGED", "LINKED", "IGNORED", "RESOLVED", "DELETED"].includes(value); }
function isEmptyObject(value: unknown): boolean { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0; }
function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown): unknown {
  if (!(error instanceof HumanFeedbackError)) return reply.code(503).send({ error: "HumanFeedback service unavailable" });
  const status = error.code === "FEEDBACK_PROJECT_NOT_FOUND" || error.code === "FEEDBACK_NOT_FOUND" || error.code === "FEEDBACK_TARGET_NOT_FOUND" ? 404
    : error.code === "FEEDBACK_MAPPING_CONFLICT" || error.code === "FEEDBACK_ALREADY_TRIAGED" ? 409 : 400;
  return reply.code(status).send({ error: error.code, message: error.message });
}
