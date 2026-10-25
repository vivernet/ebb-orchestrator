import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ProjectProjection } from "../read-models/project-projection.js";
import { ProjectIndexProjection } from "../read-models/project-index-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import type { Project } from "../../modules/projects/project-types.js";

export interface ProjectCommandService {
  create(name: string, displayName: string): Project | Promise<Project>;
}

export interface ProjectRouteDeps {
  db?: Database | undefined;
  scheduler?: SchedulerService | undefined;
  projectService?: ProjectCommandService | undefined;
}
/**
 * Регистрирует HTTP-маршруты projects и передаёт изменяющие состояние действия backend policy.
 */
export async function projectRoutes(app: FastifyInstance, deps: ProjectRouteDeps = {}): Promise<void> {
  const projection = new ProjectProjection(deps.db, deps.scheduler);
  const index = new ProjectIndexProjection(deps.db);
  app.post<{ Body: unknown }>("/api/v1/projects", async (request, reply) => {
    if (!deps.projectService) return reply.code(503).send({ error: "project service unavailable" });
    const body = parseProjectBody(request.body);
    if (!body) return reply.code(400).send({ error: "invalid project body" });

    const project = await deps.projectService.create(body.name, body.displayName);
    return reply.code(201).send({ project });
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/api/v1/projects", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "project index unavailable" });
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (request.query.limit !== undefined && (!Number.isInteger(limit) || limit! < 1 || limit! > 100)) {
      return reply.code(400).send({ error: "INVALID_LIMIT" });
    }
    try {
      return index.page(request.query.cursor, limit);
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "INVALID_CURSOR") {
        return reply.code(400).send({ error: "INVALID_CURSOR" });
      }
      return reply.code(500).send({ error: "project index unavailable" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/pause", async (request, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    try {
      const result = deps.scheduler.pauseScope("PROJECT", request.params.id, "local-user", true);
      return { projectId: request.params.id, state: result.state, updatedAt: result.updatedAt };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/projects/:id/resume", async (request, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    try {
      const result = deps.scheduler.pauseScope("PROJECT", request.params.id, "local-user", false);
      return { projectId: request.params.id, state: result.state, updatedAt: result.updatedAt };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/projects/:id", async (request) => {
    const result = projection.get(request.params.id);
    return result ?? { project: null, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, epics: [], tasks: [], approvals: [], blockers: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } };
  });
}

function parseProjectBody(value: unknown): { name: string; displayName: string } | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["name", "displayName"])) return null;
  if (!isNonEmptyString(value.name) || !isNonEmptyString(value.displayName)) return null;
  return { name: value.name, displayName: value.displayName };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
