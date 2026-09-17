/**
 * Pricing catalog — maps role/model combinations to per-token pricing.
 */

export interface PricingTier {
  role: string;
  model: string;
  inputPerToken: number;
  outputPerToken: number;
  cachedPerToken: number;
}

/** Default pricing tiers for known role/model combinations. */
const DEFAULT_TIERS: PricingTier[] = [
  { role: "developer", model: "default", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "reviewer", model: "default", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "qa", model: "default", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "integration", model: "default", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "architect", model: "default", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "developer", model: "claude-sonnet-4-20250514", inputPerToken: 0.000003, outputPerToken: 0.000015, cachedPerToken: 0.0000003 },
  { role: "developer", model: "claude-opus-4-20250514", inputPerToken: 0.000015, outputPerToken: 0.000075, cachedPerToken: 0.0000015 },
];

export class PricingCatalog {
  private tiers: Map<string, PricingTier>;

  constructor(customTiers?: PricingTier[]) {
    this.tiers = new Map();
    for (const tier of customTiers ?? DEFAULT_TIERS) {
      this.tiers.set(this.key(tier.role, tier.model), tier);
    }
  }

  private key(role: string, model: string): string {
    return `${role}:${model}`;
  }

  /** Get the pricing tier for a role/model combination. */
  getTier(role: string, model: string): PricingTier | undefined {
    return this.tiers.get(this.key(role, model));
  }

  /** Calculate cost from token counts. */
  calculateCost(
    role: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
  ): number {
    const tier = this.getTier(role, model);
    if (!tier) return 0;
    return (
      inputTokens * tier.inputPerToken +
      outputTokens * tier.outputPerToken +
      cachedTokens * tier.cachedPerToken
    );
  }

  /** Register a custom pricing tier. */
  addTier(tier: PricingTier): void {
    this.tiers.set(this.key(tier.role, tier.model), tier);
  }
}
