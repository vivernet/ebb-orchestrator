import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import type { TaskDependency } from "../../modules/work/dependency-service.js";

/** Команды управления зависимостями задач, доступные HTTP-слою. */
export interface DependencyCommandService {
  addBlockingDependency(taskId: string, dependsOnTaskId: string): TaskDependency | Promise<TaskDependency>;
  removeDependency(taskId: string, dependsOnTaskId: string): void | Promise<void>;
  listDependencies(taskId: string): TaskDependency[] | Promise<TaskDependency[]>;
}

export interface DependencyRouteDeps {
  db?: Database | undefined;
  dependencyService?: DependencyCommandService | undefined;
}

/**
 * Регистрирует query/command-маршруты графа зависимостей задач.
 *
 * Маршруты проверяют существование обеих задач до вызова доменного сервиса,
 * а внутренние тексты исключений наружу не возвращают.
 */
export async function dependencyRoutes(
  app: FastifyInstance,
  deps: DependencyRouteDeps = {},
): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id/dependencies", async (request, reply) => {
    if (!deps.db || !deps.dependencyService) return reply.code(503).send({ error: "dependency service unavailable" });
    if (!taskExists(deps.db, request.params.id)) return reply.code(404).send({ error: "task not found" });

    try {
      return { dependencies: await deps.dependencyService.listDependencies(request.params.id) };
    } catch {
      return reply.code(503).send({ error: "dependency service unavailable" });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/tasks/:id/dependencies", async (request, reply) => {
    if (!deps.db || !deps.dependencyService) return reply.code(503).send({ error: "dependency service unavailable" });
    const dependsOnTaskId = parseDependencyBody(request.body);
    if (dependsOnTaskId === null) return reply.code(400).send({ error: "invalid dependency" });
    if (!taskExists(deps.db, request.params.id) || !taskExists(deps.db, dependsOnTaskId)) {
      return reply.code(404).send({ error: "task not found" });
    }

    try {
      const dependency = await deps.dependencyService.addBlockingDependency(request.params.id, dependsOnTaskId);
      return reply.code(201).send({ dependency });
    } catch (error: unknown) {
      const reason = dependencyConflict(error);
      if (reason) return reply.code(409).send({ error: reason });
      return reply.code(503).send({ error: "dependency service unavailable" });
    }
  });

  app.delete<{ Params: { id: string; dependsOnTaskId: string } }>(
    "/api/v1/tasks/:id/dependencies/:dependsOnTaskId",
    async (request, reply) => {
      if (!deps.db || !deps.dependencyService) return reply.code(503).send({ error: "dependency service unavailable" });
      if (!taskExists(deps.db, request.params.id) || !taskExists(deps.db, request.params.dependsOnTaskId)) {
        return reply.code(404).send({ error: "task not found" });
      }

      try {
        await deps.dependencyService.removeDependency(request.params.id, request.params.dependsOnTaskId);
        return { ok: true };
      } catch {
        return reply.code(503).send({ error: "dependency service unavailable" });
      }
    },
  );
}

function taskExists(db: Database, taskId: string): boolean {
  return Boolean(db.get<{ id: string }>("SELECT id FROM tasks WHERE id = $id", { id: taskId }));
}

function parseDependencyBody(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "dependsOnTaskId") return null;
  const taskId = entries[0][1];
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.trim() !== taskId || taskId.length > 200) return null;
  return taskId;
}

function dependencyConflict(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case "Task cannot depend on itself": return "dependency conflict";
    case "Dependency already exists": return "dependency already exists";
    case "Adding this dependency would create a cycle": return "dependency cycle detected";
    default: return null;
  }
}
