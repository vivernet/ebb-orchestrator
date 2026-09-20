import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import type { EpicOrchestrator, EpicStartInput } from "../../modules/planning/epic-orchestrator.js";
import type { TemporaryTask } from "../../modules/planning/planning-types.js";

export interface EpicRouteDeps {
  db?: Database | undefined;
  epicOrchestrator?: Pick<EpicOrchestrator, "start" | "approveAndRun"> | undefined;
}

interface ProjectRow { id: string; status: string; }
interface PlanRow { id: string; project_id: string; status: string; }

/**
 * Регистрирует минимальный HTTP-контракт Epic planning/orchestration.
 *
 * Репозиторий, branch и SHA намеренно отсутствуют в body: orchestration
 * разрешает Git только из активного persisted onboarding состояния.
 */
export async function epicRoutes(app: FastifyInstance, deps: EpicRouteDeps = {}): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/v1/projects/:projectId/epics/plans",
    async (request, reply) => {
      if (!deps.db || !deps.epicOrchestrator) return reply.code(503).send({ error: "epic planning service unavailable" });
      const project = getProject(deps.db, request.params.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (project.status !== "ACTIVE") return reply.code(409).send({ error: "project is not active" });
      const body = parseStartBody(request.body);
      if (!body) return reply.code(400).send({ error: "invalid epic plan body" });
      if (!hasActiveOnboarding(deps.db, project.id)) return reply.code(409).send({ error: "active onboarding is required" });
      try {
        const plan = await deps.epicOrchestrator.start({ ...body, projectId: project.id, requestedBy: "local-user" });
        return reply.code(201).send({ plan });
      } catch (error) {
        return reply.code(classifyEpicError(error)).send({ error: "epic plan rejected" });
      }
    },
  );

  app.post<{ Params: { projectId: string; planId: string }; Body: unknown }>(
    "/api/v1/projects/:projectId/epics/plans/:planId/approve-run",
    async (request, reply) => {
      if (!deps.db || !deps.epicOrchestrator) return reply.code(503).send({ error: "epic orchestration service unavailable" });
      const project = getProject(deps.db, request.params.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (project.status !== "ACTIVE") return reply.code(409).send({ error: "project is not active" });
      if (request.body !== undefined && !isEmptyObject(request.body)) return reply.code(400).send({ error: "approval body must be empty" });
      const plan = deps.db.get<PlanRow>("SELECT id,project_id,status FROM planning_plans WHERE id=$id", { id: request.params.planId });
      if (!plan || plan.project_id !== project.id) return reply.code(404).send({ error: "epic plan not found" });
      if (plan.status === "REJECTED") return reply.code(409).send({ error: "epic plan is rejected" });
      if (!hasActiveOnboarding(deps.db, project.id)) return reply.code(409).send({ error: "active onboarding is required" });
      try {
        const result = await deps.epicOrchestrator.approveAndRun(plan.id, "local-user");
        return reply.code(200).send({ result });
      } catch (error) {
        return reply.code(classifyEpicError(error)).send({ error: "epic orchestration failed" });
      }
    },
  );
}

function getProject(db: Database, id: string): ProjectRow | undefined {
  return db.get<ProjectRow>("SELECT id,status FROM projects WHERE id=$id", { id });
}

function hasActiveOnboarding(db: Database, projectId: string): boolean {
  return Boolean(db.get<{ id: string }>(
    `SELECT oc.project_id AS id
       FROM onboarding_configs oc
       JOIN approvals a ON a.id=oc.approval_id
      WHERE oc.project_id=$projectId AND oc.status='ACTIVE'
        AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
    { projectId },
  ));
}

function parseStartBody(value: unknown): Omit<EpicStartInput, "projectId" | "requestedBy"> | null {
  if (!isPlainObject(value)) return null;
  const allowed = ["tasks", "epic", "includeProductManager", "includeArchitect", "architectureReviewRequired", "architecture_review_required"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) return null;
  const tasks = value.tasks.map(parseTask);
  if (tasks.some((task): task is null => task === null)) return null;
  if (!parseEpic(value.epic)) return null;
  for (const key of ["includeProductManager", "includeArchitect", "architectureReviewRequired", "architecture_review_required"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return null;
  }
  return {
    tasks: tasks as TemporaryTask[],
    epic: value.epic,
    ...(typeof value.includeProductManager === "boolean" ? { includeProductManager: value.includeProductManager } : {}),
    ...(typeof value.includeArchitect === "boolean" ? { includeArchitect: value.includeArchitect } : {}),
    ...(typeof value.architectureReviewRequired === "boolean" ? { architectureReviewRequired: value.architectureReviewRequired } : {}),
    ...(typeof value.architecture_review_required === "boolean" ? { architecture_review_required: value.architecture_review_required } : {}),
  };
}

function parseTask(value: unknown): TemporaryTask | null {
  if (!isPlainObject(value)) return null;
  const allowed = ["ref", "title", "goal", "context", "requirements", "acceptanceCriteria", "dependsOn", "role", "workflow", "optional"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (!["ref", "title", "role", "workflow"].every((key) => isNonEmptyString(value[key]))) return null;
  if (!Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.every(isNonEmptyString)) return null;
  for (const key of ["goal", "context"] as const) if (value[key] !== undefined && !isNonEmptyString(value[key])) return null;
  for (const key of ["requirements", "dependsOn"] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every(isNonEmptyString))) return null;
  if (value.optional !== undefined && typeof value.optional !== "boolean") return null;
  return value as unknown as TemporaryTask;
}

function parseEpic(value: unknown): value is { title: string; goal?: string } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "title" && key !== "goal")) return false;
  return isNonEmptyString(value.title) && (value.goal === undefined || isNonEmptyString(value.goal));
}

function classifyEpicError(error: unknown): 404 | 409 | 503 {
  const message = error instanceof Error ? error.message : "";
  if (/runtime|launcher|unavailable|service/i.test(message)) return 503;
  if (/not found/i.test(message)) return 404;
  return 409;
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEmptyObject(value: unknown): boolean { return isPlainObject(value) && Object.keys(value).length === 0; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
