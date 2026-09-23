/**
 * API adapter для Project.
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, type DashboardProjection, type ProjectOverviewProjection } from '@ebb-orchestrator/contracts';

/**
 * Получает ProjectOverview projection по ID проекта.
 * @param id ID проекта
 */
export async function getProjectOverview(id: string): Promise<ProjectOverviewProjection> {
  const response = await apiClient.get<ProjectOverviewProjection>(toClientPath(apiPaths.project(id)));
  return response;
}

/**
 * Получает список всех проектов через dashboard.
 */
export async function listProjects(): Promise<DashboardProjection['projects']> {
  const response = await apiClient.get<DashboardProjection>(toClientPath(apiPaths.dashboard));
  return response.projects;
}
