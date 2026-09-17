import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ProjectProjection } from "../read-models/project-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
export interface ProjectRouteDeps { db?: Database | undefined; scheduler?: SchedulerService | undefined; }
export async function projectRoutes(app: FastifyInstance, deps: ProjectRouteDeps = {}): Promise<void> {
  const projection = new ProjectProjection(deps.db, deps.scheduler);
  app.get<{ Params: { id: string } }>("/api/v1/projects/:id", async (request) => {
    const result = projection.get(request.params.id);
    return result ?? { project: null, epics: [], tasks: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } };
  });
}
