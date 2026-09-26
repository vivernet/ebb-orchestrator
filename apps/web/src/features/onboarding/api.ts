/**
 * API adapter для Onboarding.
 */

import { apiClient, toClientPath } from '../../api/client.js';
import { apiPaths, type OnboardingProjection, type OnboardingProposal } from '@ebb-orchestrator/contracts';

export type OnboardingDiscoveryResult = OnboardingProjection;

export const onboardingApi = {
  /**
   * Инициализирует discovery по пути к репозиторию.
   * @param repositoryPath Путь к репозиторию
   */
  discover: async (repositoryPath: string) => {
    const response = await apiClient.post<OnboardingDiscoveryResult>(
      toClientPath(apiPaths.onboardingDiscover),
      { repositoryPath },
    );
    return response;
  },

  /**
   * Получает статус onboarding project по ID.
   * @param id ID onboarding project
   */
  get: async (id: string) => {
    const response = await apiClient.get<OnboardingDiscoveryResult>(toClientPath(apiPaths.onboarding(id)));
    return response;
  },

  /**
   * Запрашивает approval для onboarding project.
   * @param id ID onboarding project
   */
  requestApproval: async (id: string, proposed: OnboardingProposal) => {
    const response = await apiClient.post<OnboardingDiscoveryResult>(
      toClientPath(apiPaths.onboardingApproval(id)),
      { proposed },
    );
    return response;
  },

  /**
   * Утверждает onboarding project.
   * @param id ID onboarding project
   */
  approve: async (id: string) => {
    const response = await apiClient.post<OnboardingDiscoveryResult>(
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
    const response = await apiClient.post<OnboardingDiscoveryResult>(
      toClientPath(apiPaths.onboardingActivate(id)),
      {},
    );
    return response;
  },
};
