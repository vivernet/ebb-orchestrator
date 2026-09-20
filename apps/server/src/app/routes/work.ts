import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { EpicProjection } from "../read-models/epic-projection.js";
import { TaskProjection } from "../read-models/task-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import type { Epic, Task, TaskContract } from "../../modules/work/work-types.js";
export interface WorkCommandService {
  pauseTask(taskId: string): unknown | Promise<unknown>;
  createStandaloneTask(projectId: string, contract: TaskContract): Task | Promise<Task>;
  createEpic(projectId: string, contract: TaskContract): Epic | Promise<Epic>;
  createEpicTask(epicId: string, contract: TaskContract): Task | Promise<Task>;
}
export interface WorkRouteDeps { db?: Database | undefined; workService?: WorkCommandService | undefined; scheduler?: SchedulerService | undefined; }
const emptyUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
/**
 * Регистрирует HTTP-маршруты work и передаёт изменяющие состояние действия backend policy.
 */
export async function workRoutes(app: FastifyInstance, deps: WorkRouteDeps = {}): Promise<void> {
  const epicProjection = new EpicProjection(deps.db, deps.scheduler);
  const taskProjection = new TaskProjection(deps.db, deps.scheduler);
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/projects/:id/tasks", async (request, reply) => {
    if (!deps.workService || !deps.db) return reply.code(503).send({ error: "work service unavailable" });
    const contract = parseTaskContract(request.body);
    if (!contract) return reply.code(400).send({ error: "invalid task contract" });
    if (!deps.db.get("SELECT id FROM projects WHERE id = $id", { id: request.params.id })) {
      return reply.code(404).send({ error: "project not found" });
    }
    const task = await deps.workService.createStandaloneTask(request.params.id, contract);
    return reply.code(201).send({ task });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/projects/:id/epics", async (request, reply) => {
    if (!deps.workService || !deps.db) return reply.code(503).send({ error: "work service unavailable" });
    const contract = parseTaskContract(request.body);
    if (!contract) return reply.code(400).send({ error: "invalid epic contract" });
    if (!deps.db.get("SELECT id FROM projects WHERE id = $id", { id: request.params.id })) {
      return reply.code(404).send({ error: "project not found" });
    }
    const epic = await deps.workService.createEpic(request.params.id, contract);
    return reply.code(201).send({ epic });
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/epics/:id/tasks", async (request, reply) => {
    if (!deps.workService || !deps.db) return reply.code(503).send({ error: "work service unavailable" });
    const contract = parseTaskContract(request.body);
    if (!contract) return reply.code(400).send({ error: "invalid task contract" });
    if (!deps.db.get("SELECT id FROM epics WHERE id = $id", { id: request.params.id })) {
      return reply.code(404).send({ error: "epic not found" });
    }
    const task = await deps.workService.createEpicTask(request.params.id, contract);
    return reply.code(201).send({ task });
  });

  app.get<{ Params: { id: string } }>("/api/v1/epics/:id", async (request) => epicProjection.get(request.params.id) ?? { epic: null, contract: null, lifecycle: { status: "UNKNOWN", stage: null, updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, tasks: [], approvals: [], blockers: [], events: [], usage: emptyUsage });
  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request) => taskProjection.get(request.params.id) ?? { task: null, contract: null, lifecycle: { status: "UNKNOWN", stage: null, updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [], usage: emptyUsage, waitReason: null });
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/pause", async (request, reply) => {
    if (!deps.workService) return reply.code(503).send({ error: "work service unavailable" });
    return deps.workService.pauseTask(request.params.id);
  });
}

const taskContractKeys = [
  "version", "goal", "context", "requirements", "acceptanceCriteria",
  "dependencies", "nonGoals", "definitionOfDone",
] as const;

function parseTaskContract(value: unknown): TaskContract | null {
  if (!isPlainObject(value) || !hasExactKeys(value, taskContractKeys)) return null;
  const version = value.version;
  const goal = value.goal;
  const context = value.context;
  const requirements = value.requirements;
  const acceptanceCriteria = value.acceptanceCriteria;
  const dependencies = value.dependencies;
  const nonGoals = value.nonGoals;
  const definitionOfDone = value.definitionOfDone;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (!isNonEmptyString(goal) || !isNonEmptyString(context)) return null;
  for (const key of ["requirements", "acceptanceCriteria", "dependencies", "nonGoals", "definitionOfDone"] as const) {
    if (!isStringArray(value[key])) return null;
  }
  return {
    version,
    goal,
    context,
    requirements: requirements as string[],
    acceptanceCriteria: acceptanceCriteria as string[],
    dependencies: dependencies as string[],
    nonGoals: nonGoals as string[],
    definitionOfDone: definitionOfDone as string[],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}
