import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { MergeService, type MergeResult } from "../../modules/git/merge-service.js";
import type { WorkflowEngine } from "../../modules/workflow/workflow-engine.js";
import type { EpicOrchestrator } from "../../modules/planning/epic-orchestrator.js";

/** Минимальный authority-bound контракт финального merge. */
export interface FinalMergeCommandService {
  mergeApprovedForIntegration(subjectId: string, approvalId: string, integrationRunId: string): Promise<MergeResult>;
}

/**
 * Factory получает только authoritative repository из onboarding_configs.
 * Клиентские branch/repository параметры в этот контракт не попадают.
 */
export type FinalMergeServiceFactory = (database: Database, repositoryPath: string) => FinalMergeCommandService;

export interface FinalMergeRouteDeps {
  db?: Database | undefined;
  mergeServiceFactory?: FinalMergeServiceFactory | undefined;
  workflow?: WorkflowEngine | undefined;
  epicOrchestrator?: { approveFinalMergeAsync?: EpicOrchestrator["approveFinalMergeAsync"] } | undefined;
}

interface FinalMergeBody {
  approvalId: string;
  integrationRunId: string;
}

interface ApprovalRow {
  subject_id: string;
  subject_type: string;
  type: string;
  status: string;
}

interface RepositoryRow {
  repository_path: string;
}

/**
 * Регистрирует authority-safe final merge.
 *
 * Subject и approval являются persisted идентификаторами, а repository
 * разрешается только через активный onboarding проекта. Branch, SHA и
 * integration provenance загружаются и проверяются внутри MergeService.
 */
export async function finalMergeRoutes(app: FastifyInstance, deps: FinalMergeRouteDeps = {}): Promise<void> {
  app.post<{ Params: { subjectId: string }; Body: unknown }>(
    "/api/v1/final-merges/:subjectId",
    async (request, reply) => {
      if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
      const body = parseBody(request.body);
      if (!body) return reply.code(400).send({ error: "invalid final merge body" });

      const subjectId = request.params.subjectId;
      const approval = deps.db.get<ApprovalRow>(
        "SELECT subject_id,subject_type,type,status FROM approvals WHERE id=$id",
        { id: body.approvalId },
      );
      if (!approval || approval.subject_id !== subjectId || approval.type !== "FINAL_MERGE" || approval.status !== "APPROVED") {
        return reply.code(409).send({ error: "approved FINAL_MERGE for exact subject is required" });
      }

      if (approval.subject_type === "EPIC") {
        if (!deps.epicOrchestrator?.approveFinalMergeAsync) {
          return reply.code(503).send({ error: "Epic merge authority unavailable" });
        }
        try {
          const result = await deps.epicOrchestrator.approveFinalMergeAsync(subjectId, body.approvalId);
          return reply.code(200).send({ result });
        } catch {
          return reply.code(409).send({ error: "final Epic merge provenance validation failed" });
        }
      }

      const repository = findActiveOnboardingRepository(deps.db, subjectId, approval.subject_type);
      if (!repository) return reply.code(409).send({ error: "active onboarding repository is required" });

      const factory = deps.mergeServiceFactory ?? ((database, repositoryPath) => new MergeService({ database, repoPath: repositoryPath }));
      const service = factory(deps.db, repository.repository_path);
      try {
        const result = await service.mergeApprovedForIntegration(subjectId, body.approvalId, body.integrationRunId);
        if (deps.workflow) {
          const task = deps.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: subjectId });
          if (task?.status === "READY_FOR_MERGE") {
            deps.workflow.transition(subjectId, "MERGING", {
              hasReviewPassed: true,
              hasSuccessfulIntegration: true,
              hasFinalMergeApproval: true,
              parentEpicReleased: false,
            });
            deps.workflow.transition(subjectId, "DONE", {
              hasReviewPassed: true,
              hasSuccessfulIntegration: true,
              hasFinalMergeApproval: true,
              parentEpicReleased: false,
            });
          }
        }
        return reply.code(200).send({ merge: result });
      } catch {
        // Do not expose repository paths, SHA values, or provenance details.
        return reply.code(409).send({ error: "final merge provenance validation failed" });
      }
    },
  );
}

function findActiveOnboardingRepository(db: Database, subjectId: string, subjectType: string): RepositoryRow | undefined {
  const project = subjectType === "EPIC"
    ? db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: subjectId })
    : subjectType === "TASK"
      ? db.get<{ project_id: string }>("SELECT project_id FROM tasks WHERE id=$id", { id: subjectId })
      : undefined;
  if (!project) return undefined;
  return db.get<RepositoryRow>(
    `SELECT oc.repository_path
       FROM onboarding_configs oc
       JOIN approvals onboarding_approval ON onboarding_approval.id = oc.approval_id
      WHERE oc.project_id=$projectId
        AND oc.status='ACTIVE'
        AND onboarding_approval.type='WORKFLOW_CHANGE'
        AND onboarding_approval.status='APPROVED'`,
    { projectId: project.project_id },
  );
}

function parseBody(value: unknown): FinalMergeBody | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !hasExactKeys(value, ["approvalId", "integrationRunId"])) return null;
  if (!isNonEmptyString(value.approvalId) || !isNonEmptyString(value.integrationRunId)) return null;
  return { approvalId: value.approvalId, integrationRunId: value.integrationRunId };
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
