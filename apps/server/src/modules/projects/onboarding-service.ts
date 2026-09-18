import { RepositoryDiscovery } from "./repository-discovery.js";
import type { RepositoryFacts } from "./repository-discovery.js";

export interface Onboarding {
  readonly facts: RepositoryFacts;
  readonly onboardingStatus: "new" | "existing";
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class OnboardingService {
  private readonly discovery: RepositoryDiscovery;

  constructor(discovery?: RepositoryDiscovery) {
    this.discovery = discovery ?? new RepositoryDiscovery();
  }

  async onboard(repoPath: string): Promise<Onboarding> {
    const facts = await this.discovery.discover(repoPath);

    const onboardingStatus: Onboarding["onboardingStatus"] = facts.untrustedExistingConfig
      ? "existing"
      : "new";

    return {
      facts,
      onboardingStatus,
    };
  }
}
