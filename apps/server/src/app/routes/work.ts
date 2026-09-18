import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { EpicProjection } from "../read-models/epic-projection.js";
import { TaskProjection } from "../read-models/task-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
export interface WorkCommandService { pauseTask(taskId: string): unknown | Promise<unknown>; }
export interface WorkRouteDeps { db?: Database | undefined; workService?: WorkCommandService | undefined; scheduler?: SchedulerService | undefined; }
const emptyUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
/**
 * Регистрирует HTTP-маршруты work и передаёт изменяющие состояние действия backend policy.
 */
export async function workRoutes(app: FastifyInstance, deps: WorkRouteDeps = {}): Promise<void> {
  const epicProjection = new EpicProjection(deps.db, deps.scheduler);
  const taskProjection = new TaskProjection(deps.db, deps.scheduler);
  app.get<{ Params: { id: string } }>("/api/v1/epics/:id", async (request) => epicProjection.get(request.params.id) ?? { epic: null, contract: null, lifecycle: { status: "UNKNOWN", stage: null, updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, tasks: [], approvals: [], blockers: [], events: [], usage: emptyUsage });
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request) => taskProjection.get(request.params.id) ?? { task: null, contract: null, lifecycle: { status: "UNKNOWN", stage: null, updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [], usage: emptyUsage, waitReason: null });
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/pause", async (request, reply) => {
    if (!deps.workService) return reply.code(503).send({ error: "work service unavailable" });
    return deps.workService.pauseTask(request.params.id);
  });
}
