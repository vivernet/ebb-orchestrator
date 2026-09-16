import {
  PermissionDecision,
  ActionId,
  PolicyScope,
  PolicyRuleType,
} from './permission-types.js';
import type {
  EvaluationInput,
  EvaluationResult,
} from './permission-types.js';
import { composeDecisions, getMatchingRules } from './permission-policy.js';

/**
 * Permission Engine - evaluates actions against composed policies from multiple scopes.
 * Uses most-restrictive-wins composition.
 * - Unknown/unregistered Action IDs fail closed (return ABSOLUTE_DENY)
 * - ABSOLUTE_DENY cannot be weakened by more specific scopes
 */
export class PermissionEngine {
  private readonly canonicalActions: Set<string>;

  constructor() {
    // Build set of known/canonical action IDs
    this.canonicalActions = new Set(Object.values(ActionId));
  }

  /**
   * Validate if an action ID is known/registered
   */
  isRegisteredAction(action: ActionId): boolean {
    return this.canonicalActions.has(action as string);
  }

  /**
   * Evaluate action against composed policies from multiple scopes.
   * Returns most-restrictive decision with reason and matched policy references.
   */
  evaluate(input: EvaluationInput): EvaluationResult {
    const { action, globalPolicy, projectPolicy, rolePolicy, taskPolicy } = input;

    // Unknown/unregistered Action IDs must fail closed
    if (!this.isRegisteredAction(action)) {
      return {
        decision: PermissionDecision.ABSOLUTE_DENY,
        reason: `Unknown action ID: ${action}. Only registered actions are permitted.`,
        matchedPolicyRefs: [],
      };
    }

    // Get all matching rules from all policy scopes
    const allMatchingRules = getMatchingRules(action, globalPolicy, projectPolicy, rolePolicy, taskPolicy);

    // If no rules match, default to DENY (fail closed)
    if (allMatchingRules.length === 0) {
      return {
        decision: PermissionDecision.DENY,
        reason: `No policy rules match action: ${action}. Default deny applies.`,
        matchedPolicyRefs: [],
      };
    }

    // Convert matching rules to decisions with scope info
    const decisions = allMatchingRules.map((rule: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] }) => {
      const res: { decision: PermissionDecision; scope: PolicyScope; scopeRef?: string; type: PolicyRuleType } = {
        decision: this.policyTypeToDecision(rule.type),
        scope: rule.scope,
        type: rule.type,
      };
      if (rule.scopeRef !== undefined) {
        res.scopeRef = rule.scopeRef;
      }
      return res;
    });

    // Compose decisions using most-restrictive-wins
    const { decision, matchedRefs } = composeDecisions(decisions);

    // Generate human-readable reason
    const reason = this.generateReason(decision, matchedRefs, action);

    return {
      decision,
      reason,
      matchedPolicyRefs: matchedRefs.map((ref: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType }) => {
        const res: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType } = { scope: ref.scope, type: ref.type };
        if (ref.scopeRef !== undefined) {
          res.scopeRef = ref.scopeRef;
        }
        return res;
      }),
    };
  }

  /**
   * Check if action is in the capability set for a run
   */
  isActionPermitted(action: ActionId, capabilities: ActionId[]): boolean {
    return capabilities.includes(action);
  }

  private policyTypeToDecision(type: PolicyRuleType): PermissionDecision {
    switch (type) {
      case PolicyRuleType.Allow:
        return PermissionDecision.ALLOW;
      case PolicyRuleType.Ask:
        return PermissionDecision.ASK;
      case PolicyRuleType.Deny:
        return PermissionDecision.DENY;
      case PolicyRuleType.AbsoluteDeny:
        return PermissionDecision.ABSOLUTE_DENY;
      default:
        throw new Error(`Unknown policy rule type: ${type}`);
    }
  }

   private generateReason(
     decision: PermissionDecision,
     matchedRefs: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType }[],
     _action: ActionId
   ): string {
    if (matchedRefs.length === 0) {
      switch (decision) {
        case PermissionDecision.ABSOLUTE_DENY:
          return 'Default deny: no matching policies and action is unregistered.';
        case PermissionDecision.DENY:
          return 'Default deny: no matching policies.';
        case PermissionDecision.ASK:
          return 'No matching policies; default to asking for approval.';
        case PermissionDecision.ALLOW:
          return 'No matching policies; default to allow.';
        default:
          return 'Unknown decision.';
      }
    }

    const decisionText = this.decisionToText(decision);
    const scopeText = matchedRefs
      .map((ref) => {
        const scope = ref.scope.toLowerCase();
        const refText = ref.scopeRef ? ` [${ref.scopeRef}]` : '';
        return `${scope}${refText}`;
      })
      .join(', ');

    return `${decisionText} based on policy rules from: ${scopeText}.`;
  }

  private decisionToText(decision: PermissionDecision): string {
    switch (decision) {
      case PermissionDecision.ALLOW:
        return 'Allow';
      case PermissionDecision.ASK:
        return 'Ask for approval';
      case PermissionDecision.DENY:
        return 'Deny';
      case PermissionDecision.ABSOLUTE_DENY:
        return 'Absolute deny';
      default:
        return 'Unknown';
    }
  }
}

// Export singleton instance for convenience
export const permissionEngine = new PermissionEngine();
