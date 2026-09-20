import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";

export interface OnboardingRouteDeps { db?: Database | undefined; }

/**
 * Регистрирует HTTP-маршруты onboarding и передаёт изменяющие состояние действия backend policy.
 */
export async function onboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps = {}): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/v1/onboarding/:id", async (request) => {
    if (!deps.db) {
      return {
        projectId: request.params.id,
        repository: { path: null, remoteUrl: null },
        detected: { defaultBranch: null, packageManager: null, testFramework: null, orchestratorConfigFound: false },
        proposed: { defaultBranch: null, workflow: null, roles: [], guidelines: [] },
        approvalStatus: "PENDING",
        semanticConfigApproved: false,
        localModeEnabled: false,
      };
    }

    const projectRow = deps.db.get(
      "SELECT * FROM projects WHERE id = $id",
      { id: request.params.id }
    );

    if (!projectRow) {
      return {
        projectId: request.params.id,
        repository: { path: null, remoteUrl: null },
        detected: { defaultBranch: null, packageManager: null, testFramework: null, orchestratorConfigFound: false },
        proposed: { defaultBranch: null, workflow: null, roles: [], guidelines: [] },
        approvalStatus: "PENDING",
        semanticConfigApproved: false,
        localModeEnabled: false,
      };
    }

    return {
      projectId: projectRow.id,
      repository: {
        path: projectRow.repository_path,
        remoteUrl: projectRow.github_remote_url,
      },
      detected: {
        defaultBranch: projectRow.default_branch || "main",
        packageManager: null,
        testFramework: null,
        orchestratorConfigFound: false,
      },
      proposed: {
        defaultBranch: projectRow.default_branch || "main",
        workflow: "standard",
        roles: ["Developer", "Reviewer", "QA"],
        guidelines: [],
      },
      approvalStatus: "PENDING",
      semanticConfigApproved: false,
      localModeEnabled: false,
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/onboarding/:id/activate", async (request, reply) => {
    if (!deps.db) {
      return reply.code(503).send({ error: "database unavailable" });
    }

    const project = deps.db.get(
      "SELECT id FROM projects WHERE id = $id",
      { id: request.params.id }
    );
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    // There is no persisted semantic-approval authority in the v1 schema.
    // A UI disabled state cannot substitute for this deterministic boundary.
    return reply.code(409).send({
      error: "onboarding activation requires persisted semantic approval",
    });
  });
}
