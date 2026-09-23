/**
 * API adapter для Dashboard.
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, type DashboardProjection, type ExecutionQueueProjection } from '@ebb-orchestrator/contracts';

/**
 * Получает Dashboard projection.
 */
export async function getDashboard(): Promise<DashboardProjection> {
  const response = await apiClient.get<DashboardProjection>(toClientPath(apiPaths.dashboard));
  return response;
}

/**
 * Получает ExecutionQueue projection.
 */
export async function getExecutionQueue(): Promise<ExecutionQueueProjection> {
  const response = await apiClient.get<ExecutionQueueProjection>(toClientPath(apiPaths.execution));
  return response;
}
