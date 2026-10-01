import type { FastifyInstance } from "fastify";
import { ProjectConfigError, type ProjectConfigCandidate, type ProjectConfigRevision, type ProjectConfigService } from "../../modules/projects/project-config-service.js";

export interface ProjectConfigRouteDeps { service?: ProjectConfigService; }

/** Показывает persisted candidate/active revision и принимает approval только для точного candidate hash. */
export async function projectConfigRoutes(app: FastifyInstance, deps: ProjectConfigRouteDeps = {}): Promise<void> {
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/config", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "Project Config service unavailable" });
    try {
      let current: ProjectConfigCandidate | null = null;
      let active: ProjectConfigRevision | null = null;
      let candidateInvalid = false;
      let degraded = false;
      try { current = deps.service.getCurrentCandidate(request.params.projectId) ?? null; }
      catch (error) {
        if (!(error instanceof ProjectConfigError) || error.code !== "PROJECT_CONFIG_INVALID") throw error;
        candidateInvalid = true;
      }
      try { active = deps.service.getActive(request.params.projectId) ?? null; }
      catch (error) {
        if (!(error instanceof ProjectConfigError) || error.code !== "PROJECT_CONFIG_ACTIVE_INVALID") throw error;
        degraded = true;
      }
      return reply.send({ current, active, revisions: deps.service.listRevisions(request.params.projectId), degraded, candidateInvalid });
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/v1/projects/:projectId/config/candidates", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "Project Config service unavailable" });
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: "request body must be empty" });
    try { return reply.code(201).send({ candidate: deps.service.capture(request.params.projectId) }); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { projectId: string; candidateId: string }; Body: unknown }>("/api/v1/projects/:projectId/config/candidates/:candidateId/approve", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "Project Config service unavailable" });
    const manifestHash = parseApprovalBody(request.body);
    if (!manifestHash) return reply.code(400).send({ error: "expected the displayed manifestHash" });
    try { return reply.send({ active: deps.service.approve(request.params.projectId, request.params.candidateId, manifestHash) }); }
    catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { projectId: string; revisionId: string }; Body: unknown }>("/api/v1/projects/:projectId/config/revisions/:revisionId/rollback", async (request, reply) => {
    if (!deps.service) return reply.code(503).send({ error: "Project Config service unavailable" });
    if (!isEmptyObject(request.body)) return reply.code(400).send({ error: "request body must be empty" });
    try { return reply.code(201).send({ candidate: deps.service.stageRollback(request.params.projectId, request.params.revisionId) }); }
    catch (error) { return sendError(reply, error); }
  });
}

function parseApprovalBody(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1 && Object.keys(body)[0] === "manifestHash" && typeof body.manifestHash === "string" && /^[a-f0-9]{64}$/.test(body.manifestHash) ? body.manifestHash : undefined;
}
function isEmptyObject(value: unknown): boolean { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0; }
function sendError(reply: { code(status: number): { send(body: unknown): unknown } }, error: unknown): unknown {
  if (!(error instanceof ProjectConfigError)) return reply.code(503).send({ error: "Project Config is unavailable" });
  const status = error.code === "PROJECT_CONFIG_PROJECT_NOT_FOUND" || error.code === "PROJECT_CONFIG_NOT_FOUND" ? 404
    : error.code === "PROJECT_CONFIG_CANDIDATE_NOT_CURRENT" ? 409
      : error.code === "PROJECT_CONFIG_ACTIVE_INVALID" ? 409
        : error.code === "PROJECT_CONFIG_UNSUPPORTED_PLATFORM" ? 503 : 400;
  return reply.code(status).send({ error: error.code, message: error.message });
}
