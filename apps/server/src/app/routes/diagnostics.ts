import type { FastifyInstance } from 'fastify';
import type { DiagnosticsService } from '../../platform/diagnostics/diagnostics-service.js';
/**
 * Регистрирует HTTP-маршруты diagnostics и передаёт изменяющие состояние действия backend policy.
 */
export async function diagnosticsRoutes(app: FastifyInstance, service: DiagnosticsService): Promise<void> {
  app.get('/api/v1/diagnostics', async () => service.snapshot());
}
