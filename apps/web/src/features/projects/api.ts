/**
 * API adapter для Project.
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, type ProjectOverviewProjection } from '@ebb-orchestrator/contracts';

/**
 * Получает ProjectOverview projection по ID проекта.
 * @param id ID проекта
 */
export async function getProjectOverview(id: string): Promise<ProjectOverviewProjection> {
  const response = await apiClient.get<ProjectOverviewProjection>(toClientPath(apiPaths.project(id)));
  return response;
}
