import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import type { EpicOrchestrator, EpicStartInput } from "../../modules/planning/epic-orchestrator.js";
import type { TemporaryTask } from "../../modules/planning/planning-types.js";
import { PlanningService, validatePlanningDecisions } from "../../modules/planning/planning-service.js";
import { validatePlan } from "../../modules/planning/plan-validator.js";
import { EPIC_RECOVERY_FAILURE_CODE } from "../../modules/planning/planning-types.js";
import type { PlanningPlanInput } from "../../modules/planning/planning-types.js";

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
    "/api/v1/projects/:projectId/requests",
    async (request, reply) => {
      if (!deps.db) return reply.code(503).send({ error: "planning service unavailable" });
      const project = getProject(deps.db, request.params.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (project.status !== "ACTIVE" || !hasActiveOnboarding(deps.db, project.id)) return reply.code(409).send({ error: "active onboarding is required" });
      const body = request.body;
      if (!isPlainObject(body) || Object.keys(body).length !== 1 || !isNonEmptyString(body.request) || body.request.length > 20_000) {
        return reply.code(400).send({ error: "invalid planning request" });
      }
      try {
        const created = new PlanningService(deps.db).createQueuedRequest(project.id, body.request.trim(), "local-user");
        return reply.code(202).send({ requestId: created.id, status: created.status });
      } catch {
        return reply.code(503).send({ error: "planning request unavailable" });
      }
    },
  );

  app.get<{ Params: { projectId: string; requestId: string } }>(
    "/api/v1/projects/:projectId/requests/:requestId",
    async (request, reply) => {
      if (!deps.db) return reply.code(503).send({ error: "planning service unavailable" });
      const project = getProject(deps.db, request.params.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const row = deps.db.get<{ id: string; status: string; classification: string | null; plan_id: string | null; failure_code: string | null; planning_decisions_required: number }>(
        "SELECT id,status,classification,plan_id,failure_code,planning_decisions_required FROM planning_requests WHERE id=$id AND project_id=$projectId",
        { id: request.params.requestId, projectId: project.id },
      );
      if (!row) return reply.code(404).send({ error: "planning request not found" });
      let plan: { epic: PlanningPlanInput["epic"]; tasks: PlanningPlanInput["tasks"]; planningDecisions?: ReturnType<typeof publicPlanningDecisions> } | null = null;
      if (row.plan_id) {
        const saved = deps.db.get<{ plan_json: string; status: string }>(
          "SELECT plan_json,status FROM planning_plans WHERE id=$id AND project_id=$projectId",
          { id: row.plan_id, projectId: project.id },
        );
        if (!saved) return reply.code(503).send({ error: "planning state unavailable" });
        try {
          const parsed = JSON.parse(saved.plan_json) as PlanningPlanInput;
          validatePlan(parsed);
          if (row.planning_decisions_required === 1 && saved.status === "PENDING" && !parsed.planningDecisions) throw new Error("required planning review decisions are missing");
          const decisions = parsed.planningDecisions ? publicPlanningDecisions(validatePlanningDecisions(parsed.planningDecisions)) : undefined;
          plan = {
            epic: parsed.epic ? { title: parsed.epic.title, ...(parsed.epic.goal !== undefined ? { goal: parsed.epic.goal } : {}) } : undefined,
            tasks: parsed.tasks.map((task) => ({
              ref: task.ref, title: task.title, acceptanceCriteria: task.acceptanceCriteria,
              ...(task.goal !== undefined ? { goal: task.goal } : {}),
              ...(task.dependsOn !== undefined ? { dependsOn: task.dependsOn } : {}),
              role: task.role, workflow: task.workflow,
            })),
            ...(decisions ? { planningDecisions: decisions } : {}),
          };
        } catch {
          return reply.code(503).send({ error: "planning state unavailable" });
        }
      }
      return { requestId: row.id, status: row.status, classification: row.classification, planId: row.plan_id, planVersion: row.plan_id ? 1 : null, failureCode: row.failure_code, plan };
    },
  );

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
      const body = request.body === undefined ? {} : request.body;
      if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "requestId") ||
          (body.requestId !== undefined && typeof body.requestId !== "string")) {
        return reply.code(400).send({ error: "approval body is invalid" });
      }
      const plan = deps.db.get<PlanRow>("SELECT id,project_id,status FROM planning_plans WHERE id=$id", { id: request.params.planId });
      if (!plan || plan.project_id !== project.id) return reply.code(404).send({ error: "epic plan not found" });
      const linkedRequest = deps.db.get<{ id: string; classification: string | null; status: string; failure_code: string | null }>(
        "SELECT id,classification,status,failure_code FROM planning_requests WHERE project_id=$projectId AND plan_id=$planId",
        { projectId: project.id, planId: plan.id },
      );
      if (linkedRequest) {
        if (linkedRequest.classification !== "EPIC") return reply.code(409).send({ error: "only an Epic plan can be approved and run" });
        if (body.requestId === undefined) return reply.code(409).send({ error: "request-bound plan approval requires its request ID" });
        if (body.requestId !== linkedRequest.id) return reply.code(404).send({ error: "epic plan not found" });
        const retryingRecoveryFailure = linkedRequest.status === "FAILED" && linkedRequest.failure_code === EPIC_RECOVERY_FAILURE_CODE;
        if (linkedRequest.status !== "PLAN_PENDING_APPROVAL" && linkedRequest.status !== "MATERIALIZED" && !retryingRecoveryFailure) {
          return reply.code(409).send({ error: "planning request is not awaiting approval" });
        }
      } else if (body.requestId !== undefined) {
        return reply.code(404).send({ error: "epic plan not found" });
      }
      if (plan.status === "REJECTED") return reply.code(409).send({ error: "epic plan is rejected" });
      if (!hasActiveOnboarding(deps.db, project.id)) return reply.code(409).send({ error: "active onboarding is required" });
      try {
        const result = linkedRequest
          ? await deps.epicOrchestrator.approveAndRun(plan.id, "local-user", linkedRequest.id)
          : await deps.epicOrchestrator.approveAndRun(plan.id, "local-user");
        return reply.code(200).send({ result });
      } catch (error) {
        return reply.code(classifyEpicError(error)).send({ error: "epic orchestration failed" });
      }
    },
  );
}

function publicPlanningDecisions(value: import("../../modules/planning/planning-types.js").PlanningDecisions) {
  const { productManager, architect } = value;
  return {
    productManager: {
      version: productManager.version,
      outcome: productManager.outcome,
      ...(productManager.goal !== undefined ? { goal: productManager.goal } : {}),
      ...(productManager.userBehavior ? { userBehavior: productManager.userBehavior } : {}),
      ...(productManager.scope ? { scope: productManager.scope } : {}),
      ...(productManager.nonGoals ? { nonGoals: productManager.nonGoals } : {}),
      ...(productManager.requirements ? { requirements: productManager.requirements } : {}),
      ...(productManager.acceptanceCriteria ? { acceptanceCriteria: productManager.acceptanceCriteria } : {}),
    },
    architect: {
      version: architect.version,
      outcome: architect.outcome,
      ...(architect.components ? { components: architect.components } : {}),
      ...(architect.interfaces ? { interfaces: architect.interfaces } : {}),
      ...(architect.dataFlow ? { dataFlow: architect.dataFlow } : {}),
      ...(architect.migrations ? { migrations: architect.migrations } : {}),
      ...(architect.decisions ? { decisions: architect.decisions } : {}),
      ...(architect.proposals ? { proposals: architect.proposals.map(({ type, title, rationale }) => ({ type, title, rationale })) } : {}),
      ...(architect.architectureReviewRequired !== undefined ? { architectureReviewRequired: architect.architectureReviewRequired } : {}),
    },
  };
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
        AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
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
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
