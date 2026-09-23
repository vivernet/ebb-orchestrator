/**
 * API adapter для Onboarding.
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths } from '@ebb-orchestrator/contracts';

export const onboardingApi = {
  /**
   * Инициализирует discovery по URL репозитория.
   * @param repositoryUrl URL репозитория
   */
  discover: async (repositoryUrl: string) => {
    const response = await apiClient.post<unknown>(
      toClientPath(apiPaths.onboardingDiscover),
      { repositoryUrl },
    );
    return response;
  },

  /**
   * Получает статус onboarding project по ID.
   * @param id ID onboarding project
   */
  get: async (id: string) => {
    const response = await apiClient.get<unknown>(toClientPath(apiPaths.onboarding(id)));
    return response;
  },

  /**
   * Запрашивает approval для onboarding project.
   * @param id ID onboarding project
   */
  requestApproval: async (id: string) => {
    const response = await apiClient.post<unknown>(
      toClientPath(apiPaths.onboardingApproval(id)),
      {},
    );
    return response;
  },

  /**
   * Утверждает onboarding project.
   * @param id ID onboarding project
   */
  approve: async (id: string) => {
    const response = await apiClient.post<unknown>(
      toClientPath(apiPaths.onboardingApprove(id)),
      {},
    );
    return response;
  },

  /**
   * Активирует onboarding project.
   * @param id ID onboarding project
   */
  activate: async (id: string) => {
    const response = await apiClient.post<unknown>(
      toClientPath(apiPaths.onboardingActivate(id)),
      {},
    );
    return response;
  },
};
