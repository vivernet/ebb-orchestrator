import type { FastifyInstance } from 'fastify';
import type { GitHubSyncWorker } from '../../modules/github/github-sync-worker.js';
export interface GitHubRouteDeps { worker: GitHubSyncWorker; repository: string; }
/**
 * Регистрирует HTTP-маршруты github и передаёт изменяющие состояние действия backend policy.
 */
export async function githubRoutes(app: FastifyInstance, deps: GitHubRouteDeps): Promise<void> {
  app.post('/api/v1/github/sync', async (_request, reply) => {
    const status = await deps.worker.syncIssues(deps.repository);
    return reply.send({ status });
  });
}
