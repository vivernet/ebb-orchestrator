/**
 * Secrets management routes.
 * Note: No endpoint returns secret plaintext after storage.
 */
import type { FastifyInstance } from "fastify";
import { InMemorySecretStore } from '../../platform/security/secret-store.js';
import { KeyringSecretStore } from '../../platform/security/keyring-secret-store.js';
import type { Database } from '../../platform/database/database.js';

export interface SecretsRouteDeps {
  db?: Database | undefined;
  useKeyring?: boolean;
}

/**
 * Регистрирует HTTP-маршруты secrets и передаёт изменяющие состояние действия backend policy.
 */
export async function secretsRoutes(
  app: FastifyInstance,
  deps: SecretsRouteDeps = {}
): Promise<void> {
  const store = deps.useKeyring !== false && deps.db
    ? new KeyringSecretStore(deps.db)
    : new InMemorySecretStore(deps.db);

  // Store a secret
  app.post<{ Body: { service: string; name: string; value: string } }>(
    "/api/v1/secrets",
    {
      schema: {
        body: {
          type: "object",
          required: ["service", "name", "value"],
          properties: {
            service: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            value: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, name, value } = request.body;
      const result = await store.store(service, name, value);
      // Return metadata only - never the plaintext value
      return reply.code(201).send({
        id: result.id,
        service: result.service,
        name: result.name,
      });
    }
  );

  // List secrets for a service (metadata only)
  app.get<{ Params: { service: string } }>(
    "/api/v1/secrets/:service",
    {
      schema: {
        params: {
          type: "object",
          required: ["service"],
          properties: {
            service: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const { service } = request.params;
      const secrets = await store.listMetadata(service);
      // Return metadata only - never plaintext values
      return {
        service,
        secrets: secrets.map(s => ({
          referenceId: s.referenceId,
          name: s.name,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      };
    }
  );

  // Get metadata for a specific secret
  app.get<{ Params: { service: string; name: string } }>(
    "/api/v1/secrets/:service/:name",
    {
      schema: {
        params: {
          type: "object",
          required: ["service", "name"],
          properties: {
            service: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, name } = request.params;
      const metadata = await store.listMetadata(service);
      const found = metadata.find((item) => item.name === name);
      if (!found) {
        return reply.code(404).send({ error: "Secret not found" });
      }
      return found;
    }
  );

  // Delete a secret
  app.delete<{ Params: { service: string; name: string } }>(
    "/api/v1/secrets/:service/:name",
    {
      schema: {
        params: {
          type: "object",
          required: ["service", "name"],
          properties: {
            service: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { service, name } = request.params;
      await store.revoke(service, name);
      return reply.code(204).send();
    }
  );
}
