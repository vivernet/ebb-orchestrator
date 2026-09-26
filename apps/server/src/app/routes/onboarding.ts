import type { FastifyInstance } from "fastify";
import { ONBOARDING_CONTRACT_VERSION, onboardingApproveRequestSchema, onboardingApprovalRequestSchema, onboardingDiscoverRequestSchema } from "@ebb-orchestrator/contracts";
import type { OnboardingCommandService } from "../../modules/projects/onboarding-service.js";
import { OnboardingError } from "../../modules/projects/onboarding-service.js";

export { type OnboardingCommandService };
export interface OnboardingRouteDeps { onboardingService?: OnboardingCommandService; }

/** DTO-only HTTP adapter for the transaction-owned onboarding command service. */
export async function onboardingRoutes(app: FastifyInstance, deps: OnboardingRouteDeps = {}): Promise<void> {
  app.post<{ Body: unknown }>("/api/v1/onboarding/discover", async (request, reply) => {
    if (!deps.onboardingService) return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг недоступен.");
    const body = onboardingDiscoverRequestSchema.safeParse(request.body);
    if (!body.success) return error(reply, 400, "ONBOARDING_INVALID_REPOSITORY", "Некорректный репозиторий.");
    try { return reply.code(201).send(await deps.onboardingService.discoverAndCreateDraft(body.data.repositoryPath)); } catch (cause) { return sendCause(reply, cause); }
  });
  app.get<{ Params: { id: string } }>("/api/v1/onboarding/:id", async (request, reply) => {
    if (!deps.onboardingService) return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг недоступен.");
    const result = deps.onboardingService.getProjection(request.params.id);
    return result ? reply.code(200).send(result) : error(reply, 404, "ONBOARDING_NOT_FOUND", "Онбординг не найден.");
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/onboarding/:id/approval", async (request, reply) => {
    if (!deps.onboardingService) return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг недоступен.");
    const body = onboardingApprovalRequestSchema.safeParse(request.body);
    if (!body.success) return error(reply, 400, "ONBOARDING_INVALID_PROPOSAL", "Некорректное предложение onboarding.");
    try { return reply.code(201).send(deps.onboardingService.requestApproval(request.params.id, body.data.proposed)); } catch (cause) { return sendCause(reply, cause); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/onboarding/:id/approve", async (request, reply) => {
    if (!deps.onboardingService) return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг недоступен.");
    const body = onboardingApproveRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return error(reply, 400, "ONBOARDING_INVALID_PROPOSAL", "Некорректное тело approve.");
    try { return reply.code(200).send(deps.onboardingService.approve(request.params.id, body.data.note)); } catch (cause) { return sendCause(reply, cause); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/onboarding/:id/activate", async (request, reply) => {
    if (!deps.onboardingService) return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг недоступен.");
    if (JSON.stringify(request.body ?? {}) !== "{}") return error(reply, 400, "ONBOARDING_INVALID_PROPOSAL", "Некорректное тело activate.");
    try { return reply.code(200).send(deps.onboardingService.activate(request.params.id)); } catch (cause) { return sendCause(reply, cause); }
  });
}

function sendCause(reply: { code(status: number): { send(body: unknown): unknown } }, cause: unknown): unknown {
  if (cause instanceof OnboardingError) {
    const status = ["ONBOARDING_NOT_FOUND"].includes(cause.code) ? 404 : ["ONBOARDING_APPROVAL_PENDING", "ONBOARDING_NOT_PENDING", "ONBOARDING_NOT_APPROVED"].includes(cause.code) ? 409 : 400;
    return error(reply, status, cause.code, cause.message);
  }
  return error(reply, 503, "ONBOARDING_UNAVAILABLE", "Онбординг временно недоступен.");
}
function error(reply: { code(status: number): { send(body: unknown): unknown } }, status: number, code: string, message: string): unknown { return reply.code(status).send({ contractVersion: ONBOARDING_CONTRACT_VERSION, error: { code, message } }); }
