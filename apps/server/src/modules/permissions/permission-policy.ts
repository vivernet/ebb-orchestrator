import { PermissionDecision, PolicyScope, PolicyRuleType } from './permission-types.js';
import type { PolicyRule, ActionId } from './permission-types.js';

// Наиболее ограничительный ordering: ALLOW < ASK < DENY < ABSOLUTE_DENY
function decisionToRank(decision: PermissionDecision): number {
  switch (decision) {
    case PermissionDecision.ALLOW:
      return 0;
    case PermissionDecision.ASK:
      return 1;
    case PermissionDecision.DENY:
      return 2;
    case PermissionDecision.ABSOLUTE_DENY:
      return 3;
    default:
      return -1;
  }
}

// Преобразует policy rule type to decision
/**
 * Предоставляет публичный контракт модуля permission-policy для взаимодействия слоёв приложения.
 */
export function ruleTypeToDecision(type: PolicyRuleType): PermissionDecision {
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

/**
 * Объединяет multiple policy decisions using most-restrictive-wins.
 * ABSOLUTE_DENY cannot be weakened by more specific scopes.
 */
export function composeDecisions(
  decisions: { decision: PermissionDecision; scope: PolicyScope; scopeRef?: string; type: PolicyRuleType }[]
): { decision: PermissionDecision; matchedRefs: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType }[] } {
  if (decisions.length === 0) {
    return { decision: PermissionDecision.ABSOLUTE_DENY, matchedRefs: [] };
  }

  // Находит most restrictive decision
  let maxRank = -1;
  let maxDecision: PermissionDecision = PermissionDecision.ABSOLUTE_DENY;

  for (const { decision } of decisions) {
    const rank = decisionToRank(decision);
    if (rank > maxRank) {
      maxRank = rank;
      maxDecision = decision;
    }
  }

  // Collect all refs that match the most restrictive decision
  const matchedRefs = decisions
    .filter(({ decision }) => decision === maxDecision)
    .map(({ scope, scopeRef, type }) => {
      const result: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType } = { scope, type };
      if (scopeRef !== undefined) {
        result.scopeRef = scopeRef;
      }
      return result;
    });

  return { decision: maxDecision, matchedRefs };
}

/**
 * Проверяет if action is in policy rule
 */
export function actionMatchesRule(action: string, rule: PolicyRule): boolean {
  return rule.actions.includes(action as never);
}

/**
 * Получает all rules that apply to the given action across all policy scopes
 */
export function getMatchingRules(
  action: string,
  globalPolicy?: PolicyRule[],
  projectPolicy?: PolicyRule[],
  rolePolicy?: PolicyRule[],
  taskPolicy?: PolicyRule[]
): { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] }[] {
  const result: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] }[] = [];

  if (globalPolicy) {
    for (const rule of globalPolicy) {
      if (actionMatchesRule(action, rule)) {
        result.push({ scope: PolicyScope.Global, type: rule.type, actions: rule.actions.map((a: ActionId) => a as string) });
      }
    }
  }

  if (projectPolicy) {
    for (const rule of projectPolicy) {
      if (actionMatchesRule(action, rule)) {
        const res: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] } = { scope: PolicyScope.Project, type: rule.type, actions: rule.actions.map((a: ActionId) => a as string) };
        if (rule.scopeRef !== undefined) {
          res.scopeRef = rule.scopeRef;
        }
        result.push(res);
      }
    }
  }

  if (rolePolicy) {
    for (const rule of rolePolicy) {
      if (actionMatchesRule(action, rule)) {
        const res: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] } = { scope: PolicyScope.Role, type: rule.type, actions: rule.actions.map((a: ActionId) => a as string) };
        if (rule.scopeRef !== undefined) {
          res.scopeRef = rule.scopeRef;
        }
        result.push(res);
      }
    }
  }

  if (taskPolicy) {
    for (const rule of taskPolicy) {
      if (actionMatchesRule(action, rule)) {
        const res: { scope: PolicyScope; scopeRef?: string; type: PolicyRuleType; actions: string[] } = { scope: PolicyScope.Task, type: rule.type, actions: rule.actions.map((a: ActionId) => a as string) };
        if (rule.scopeRef !== undefined) {
          res.scopeRef = rule.scopeRef;
        }
        result.push(res);
      }
    }
  }

  return result;
}
