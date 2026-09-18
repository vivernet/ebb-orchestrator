import type { FastifyInstance } from 'fastify';
import type { DiagnosticsService } from '../../platform/diagnostics/diagnostics-service.js';
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function diagnosticsRoutes(app: FastifyInstance, service: DiagnosticsService): Promise<void> {
  app.get('/api/v1/diagnostics', async () => service.snapshot());
}
