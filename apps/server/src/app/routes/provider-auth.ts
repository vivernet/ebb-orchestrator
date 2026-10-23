/**
 * Маршруты авторизации провайдеров (plan-24, Task 4).
 *
 * Все маршруты живут под защитой глобального auth/CSRF-хука createApp:
 * GET — аутентифицированная сессия, изменяющие методы — Origin + CSRF.
 * Привязка к сессии берётся из `request.sessionId`, установленного хуком.
 *
 * API-проекции никогда не содержат токенов, verifier/state, device_code и
 * nonce — только flowId/статус/публичные поля.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ProviderAuthError,
  type ProviderAuthFlowService,
} from "../../modules/runtime/providers/auth/provider-auth-flow.js";
import { ProviderConfigurationMissingError } from "../../modules/runtime/providers/provider-settings-repository.js";

export interface ProviderAuthRouteDeps {
  readonly service?: ProviderAuthFlowService;
}

type AuthRequest = FastifyRequest & { readonly sessionId?: string };

function sessionBindingOf(request: AuthRequest): string {
  if (!request.sessionId || request.sessionId.length === 0) {
    throw new Error("PROVIDER_AUTH_SESSION_ABSENT");
  }
  return request.sessionId;
}

function statusFor(error: unknown): { code: number; kind: string } {
  if (error instanceof ProviderAuthError) {
    switch (error.kind) {
      case "PROVIDER_UNKNOWN":
      case "AUTH_METHOD_UNKNOWN":
        return { code: 404, kind: error.kind };
      case "AUTH_METHOD_NOT_INTERACTIVE":
        return { code: 400, kind: error.kind };
      case "AUTH_FLOW_NOT_FOUND":
        return { code: 404, kind: error.kind };
      case "AUTH_FLOW_SESSION_MISMATCH":
        return { code: 403, kind: error.kind };
      case "AUTH_FLOW_FINISHED":
        return { code: 409, kind: error.kind };
      case "AUTH_DISCONNECT_MISSING_CONFIG":
        return { code: 404, kind: error.kind };
      case "AUTH_REFRESH_EXPIRED":
        return { code: 409, kind: error.kind };
      case "AUTH_REFRESH_TRANSIENT":
      case "AUTH_CREDENTIAL_STORE_UNAVAILABLE":
        return { code: 503, kind: error.kind };
      case "AUTH_REFRESH_NO_STRATEGY":
        return { code: 400, kind: error.kind };
      case "AUTH_CREDENTIAL_MISSING":
        return { code: 404, kind: error.kind };
      default:
        return { code: 502, kind: error.kind };
    }
  }
  if (error instanceof ProviderConfigurationMissingError) {
    return { code: 404, kind: "PROVIDER_AUTH_DISCONNECT_MISSING_CONFIG" };
  }
  return { code: 502, kind: "PROVIDER_AUTH_UNAVAILABLE" };
}

/**
 * Регистрирует маршруты авторизации провайдеров. Если сервис не передан —
 * все маршруты отвечают 503 (composition-зависимость отсутствует).
 */
export async function providerAuthRoutes(app: FastifyInstance, deps: ProviderAuthRouteDeps = {}): Promise<void> {
  const service = deps.service;
  if (!service) {
    app.get("/api/v1/providers/auth/status/:providerId", async (_request, reply) => reply.code(503).send({ error: "provider auth unavailable" }));
    return;
  }

  app.post<{ Body: { providerId?: unknown; methodId?: unknown } }>("/api/v1/providers/auth/start", async (request, reply) => {
    const { providerId, methodId } = request.body;
    if (typeof providerId !== "string" || typeof methodId !== "string") {
      return reply.code(400).send({ error: "PROVIDER_AUTH_INVALID_REQUEST" });
    }
    try {
      const result = await service.beginAuthorization({ providerId, methodId, sessionBinding: sessionBindingOf(request) });
      return reply.code(201).send(result);
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });

  app.get<{ Params: { flowId: string } }>("/api/v1/providers/auth/:flowId", async (request, reply) => {
    try {
      return service.getFlowStatus(request.params.flowId, sessionBindingOf(request));
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });

  app.post<{ Params: { flowId: string } }>("/api/v1/providers/auth/:flowId/poll", async (request, reply) => {
    try {
      return service.pollAuthorization(request.params.flowId, sessionBindingOf(request));
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });

  app.post<{ Params: { flowId: string } }>("/api/v1/providers/auth/:flowId/cancel", async (request, reply) => {
    try {
      const cancelled = service.cancelAuthorization(request.params.flowId, sessionBindingOf(request));
      return reply.code(cancelled ? 204 : 409).send();
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });

  app.post<{ Body: { providerId?: unknown } }>("/api/v1/providers/auth/disconnect", async (request, reply) => {
    const { providerId } = request.body;
    if (typeof providerId !== "string") {
      return reply.code(400).send({ error: "PROVIDER_AUTH_INVALID_REQUEST" });
    }
    try {
      return await service.disconnectProvider(providerId, sessionBindingOf(request));
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/auth/status/:providerId", async (request, reply) => {
    try {
      return service.getProviderAuthStatus(request.params.providerId, sessionBindingOf(request));
    } catch (error) {
      const { code, kind } = statusFor(error);
      return reply.code(code).send({ error: kind });
    }
  });
}
