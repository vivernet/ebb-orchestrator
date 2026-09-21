import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../../../src/modules/permissions/permission-engine.js';
import {
  PermissionDecision,
  ActionId,
  PolicyScope,
  PolicyRuleType,
} from '../../../src/modules/permissions/permission-types.js';
import type { EvaluationInput } from '../../../src/modules/permissions/permission-types.js';
import { composeDecisions } from '../../../src/modules/permissions/permission-policy.js';

const engine = new PermissionEngine();

// Тестовые случаи для проверки Permission Engine.
interface TestCase {
  name: string;
  input: EvaluationInput;
  expectedDecision: PermissionDecision;
  expectedReasonContains?: string;
  expectedMatchedRefsCount?: number;
}

const testCases: TestCase[] = [
  // Тест 1: политик нет, действие есть в capability -> ALLOW (доступ на основе capability).
  {
    name: 'should allow when action is in capability list',
    input: {
      capability: [ActionId.WorkspaceRead],
      action: ActionId.WorkspaceRead,
    },
    expectedDecision: PermissionDecision.ALLOW,
    expectedReasonContains: 'capability',
    expectedMatchedRefsCount: 0,
  },

  // Тест 2: глобальный ALLOW -> ALLOW.
  {
    name: 'should allow when global policy allows',
    input: {
      capability: [ActionId.WorkspaceRead],
      action: ActionId.WorkspaceRead,
      globalPolicy: [
        {
          scope: PolicyScope.Global,
          actions: [ActionId.WorkspaceRead],
          type: PolicyRuleType.Allow,
        },
      ],
    },
    expectedDecision: PermissionDecision.ALLOW,
    expectedMatchedRefsCount: 1,
  },

  // Тест 3: глобальный ABSOLUTE_DENY -> ABSOLUTE_DENY (его нельзя ослабить).
  {
    name: 'should absolute deny when global policy has absolute deny',
    input: {
      capability: [ActionId.WorkspaceRead],
      action: ActionId.WorkspaceRead,
      globalPolicy: [
        {
          scope: PolicyScope.Global,
          actions: [ActionId.WorkspaceRead],
          type: PolicyRuleType.AbsoluteDeny,
        },
      ],
      taskPolicy: [
        {
          scope: PolicyScope.Task,
          scopeRef: 'task-123',
          actions: [ActionId.WorkspaceRead],
          type: PolicyRuleType.Allow,
        },
      ],
    },
    expectedDecision: PermissionDecision.ABSOLUTE_DENY,
    expectedMatchedRefsCount: 1,
  },

  // Тест 4: DENY задачи перекрывает ALLOW проекта (побеждает самое строгое правило).
  {
    name: 'should deny when task denies even if project allows',
    input: {
      capability: [ActionId.GitCommit],
      action: ActionId.GitCommit,
      projectPolicy: [
        {
          scope: PolicyScope.Project,
          scopeRef: 'proj-456',
          actions: [ActionId.GitCommit],
          type: PolicyRuleType.Allow,
        },
      ],
      taskPolicy: [
        {
          scope: PolicyScope.Task,
          scopeRef: 'task-789',
          actions: [ActionId.GitCommit],
          type: PolicyRuleType.Deny,
        },
      ],
    },
    expectedDecision: PermissionDecision.DENY,
    expectedMatchedRefsCount: 1,
  },

  // Тест 5: несколько политик одинаковой строгости -> возвращаются все refs.
  {
    name: 'should return all matched refs when multiple policies have same decision',
    input: {
      capability: [ActionId.ProjectBuild],
      action: ActionId.ProjectBuild,
      globalPolicy: [
        {
          scope: PolicyScope.Global,
          actions: [ActionId.ProjectBuild],
          type: PolicyRuleType.Deny,
        },
      ],
      rolePolicy: [
        {
          scope: PolicyScope.Role,
          scopeRef: 'developer',
          actions: [ActionId.ProjectBuild],
          type: PolicyRuleType.Deny,
        },
      ],
    },
    expectedDecision: PermissionDecision.DENY,
    expectedMatchedRefsCount: 2,
  },

  // Тест 6: неизвестное действие -> ABSOLUTE_DENY (fail closed).
  {
    name: 'should absolute deny unknown action IDs (fail closed)',
    input: {
      capability: [ActionId.WorkspaceRead],
      action: 'unknown.action' as ActionId,
    },
    expectedDecision: PermissionDecision.ABSOLUTE_DENY,
    expectedReasonContains: 'Unknown action ID',
    expectedMatchedRefsCount: 0,
  },

  // Тест 7: ASK из политики роли -> ASK.
  {
    name: 'should ask when role policy requires approval',
    input: {
      capability: [ActionId.SubmitResult],
      action: ActionId.SubmitResult,
      rolePolicy: [
        {
          scope: PolicyScope.Role,
          scopeRef: 'qa',
          actions: [ActionId.SubmitResult],
          type: PolicyRuleType.Ask,
        },
      ],
    },
    expectedDecision: PermissionDecision.ASK,
    expectedMatchedRefsCount: 1,
  },

  // Тест 8: DENY (более строгое правило) побеждает ASK.
  {
    name: 'should deny when one policy denies and another asks',
    input: {
      capability: [ActionId.CommandExec],
      action: ActionId.CommandExec,
      rolePolicy: [
        {
          scope: PolicyScope.Role,
          scopeRef: 'admin',
          actions: [ActionId.CommandExec],
          type: PolicyRuleType.Ask,
        },
      ],
      projectPolicy: [
        {
          scope: PolicyScope.Project,
          scopeRef: 'restricted-project',
          actions: [ActionId.CommandExec],
          type: PolicyRuleType.Deny,
        },
      ],
    },
    expectedDecision: PermissionDecision.DENY,
    expectedMatchedRefsCount: 1,
  },

  // Тест 9: ABSOLUTE_DENY из политики задачи -> ABSOLUTE_DENY.
  {
    name: 'should absolute deny when task policy has absolute deny',
    input: {
      capability: [ActionId.WorkspacePatch],
      action: ActionId.WorkspacePatch,
      taskPolicy: [
        {
          scope: PolicyScope.Task,
          scopeRef: 'frozen-task',
          actions: [ActionId.WorkspacePatch],
          type: PolicyRuleType.AbsoluteDeny,
        },
      ],
    },
    expectedDecision: PermissionDecision.ABSOLUTE_DENY,
    expectedMatchedRefsCount: 1,
  },

  // Тест 10: ALLOW роли + ALLOW задачи -> ALLOW.
  {
    name: 'should allow when both role and task allow',
    input: {
      capability: [ActionId.WorkspaceSearch],
      action: ActionId.WorkspaceSearch,
      rolePolicy: [
        {
          scope: PolicyScope.Role,
          scopeRef: 'developer',
          actions: [ActionId.WorkspaceSearch],
          type: PolicyRuleType.Allow,
        },
      ],
      taskPolicy: [
        {
          scope: PolicyScope.Task,
          scopeRef: 'task-abc',
          actions: [ActionId.WorkspaceSearch],
          type: PolicyRuleType.Allow,
        },
      ],
    },
    expectedDecision: PermissionDecision.ALLOW,
    expectedMatchedRefsCount: 2,
  },

  // Тест 11: ASK задачи + ALLOW проекта -> ASK.
  {
    name: 'should ask when task asks even if project allows',
    input: {
      capability: [ActionId.GitDiff],
      action: ActionId.GitDiff,
      projectPolicy: [
        {
          scope: PolicyScope.Project,
          scopeRef: 'proj-123',
          actions: [ActionId.GitDiff],
          type: PolicyRuleType.Allow,
        },
      ],
      taskPolicy: [
        {
          scope: PolicyScope.Task,
          scopeRef: 'audit-task',
          actions: [ActionId.GitDiff],
          type: PolicyRuleType.Ask,
        },
      ],
    },
    expectedDecision: PermissionDecision.ASK,
    expectedMatchedRefsCount: 1,
  },
];

describe('PermissionEngine', () => {
  describe('evaluate', () => {
    testCases.forEach(({ name, input, expectedDecision, expectedReasonContains, expectedMatchedRefsCount }) => {
      it(name, () => {
        const result = engine.evaluate(input);

        expect(result.decision).toBe(expectedDecision);

        if (expectedReasonContains) {
          expect(result.reason).toContain(expectedReasonContains);
        }

        if (expectedMatchedRefsCount !== undefined) {
          expect(result.matchedPolicyRefs.length).toBe(expectedMatchedRefsCount);
        }
      });
    });
  });

  describe('isRegisteredAction', () => {
    it('should return true for known action IDs', () => {
      expect(engine.isRegisteredAction(ActionId.WorkspaceRead)).toBe(true);
      expect(engine.isRegisteredAction(ActionId.GitCommit)).toBe(true);
    });

    it('should return false for unknown action IDs', () => {
      expect(engine.isRegisteredAction('unknown.action' as ActionId)).toBe(false);
      expect(engine.isRegisteredAction('completely.random.action' as ActionId)).toBe(false);
    });
  });

  describe('isActionPermitted', () => {
    it('should return true when action is in capabilities', () => {
      expect(
        engine.isActionPermitted(ActionId.WorkspaceRead, [ActionId.WorkspaceRead, ActionId.WorkspaceSearch])
      ).toBe(true);
    });

    it('should return false when action is not in capabilities', () => {
      expect(
        engine.isActionPermitted(ActionId.GitCommit, [ActionId.WorkspaceRead, ActionId.WorkspaceSearch])
      ).toBe(false);
    });
  });

  describe('composeDecisions', () => {
    it('should return ABSOLUTE_DENY when decisions array is empty', () => {
      const result = composeDecisions([]);
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
    });

    it('should return most restrictive decision', () => {
      const result = composeDecisions([
        {
          decision: PermissionDecision.ALLOW,
          scope: PolicyScope.Project,
          type: PolicyRuleType.Allow,
        },
        {
          decision: PermissionDecision.DENY,
          scope: PolicyScope.Task,
          type: PolicyRuleType.Deny,
        },
        {
          decision: PermissionDecision.ASK,
          scope: PolicyScope.Role,
          type: PolicyRuleType.Ask,
        },
      ]);
      expect(result.decision).toBe(PermissionDecision.DENY);
    });

    it('should collect all refs with most restrictive decision', () => {
      const result = composeDecisions([
        {
          decision: PermissionDecision.DENY,
          scope: PolicyScope.Global,
          type: PolicyRuleType.Deny,
        },
        {
          decision: PermissionDecision.ABSOLUTE_DENY,
          scope: PolicyScope.Project,
          type: PolicyRuleType.AbsoluteDeny,
        },
        {
          decision: PermissionDecision.DENY,
          scope: PolicyScope.Role,
          type: PolicyRuleType.Deny,
        },
        {
          decision: PermissionDecision.ABSOLUTE_DENY,
          scope: PolicyScope.Task,
          scopeRef: 'task-xyz',
          type: PolicyRuleType.AbsoluteDeny,
        },
      ]);
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(result.matchedRefs.length).toBe(2);
    });
  });
});
