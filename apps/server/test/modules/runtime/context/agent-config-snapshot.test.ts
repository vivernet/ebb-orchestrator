import { describe, expect, it } from "vitest";
import {
  assertSupportedBinding,
  createAgentConfigSnapshot,
  projectDeveloperWorkspace,
  selectRoleItems,
  shouldSelectKnowledge,
  type AgentConfigSnapshotSource,
  type RoleSelectedKnowledge,
} from "../../../../src/modules/runtime/context/agent-config-snapshot.js";
import type {
  ContextBudgetPolicyV1,
  ContextManifestRoleV1,
  ContextPolicyIdentityV1,
  ContextSubjectV1,
  ContextWorkspaceIdentityV1,
} from "../../../../src/modules/context/context-types.js";

const digest = "a".repeat(64);

const policyIdentity: ContextPolicyIdentityV1 = {
  providerId: "provider-a",
  providerPolicyId: "provider-v1",
  runtimeId: "hermes",
  runtimePolicyId: "local-v1",
};

const workspaceIdentity: ContextWorkspaceIdentityV1 = {
  repository: "https://workspace-user-marker:workspace-password-marker@workspace-host-marker/EbbRepo?token=workspace-query-token-marker",
  workspace: "C:/Users/alex1/Repos/EbbRepo/.ebb-orchestrator/worktrees/TASK-1",
  worktree: "TASK-1",
};

/** Канонический вход сборщика снимка; поля можно переопределить. */
function snapshotSource(overrides: Partial<AgentConfigSnapshotSource> = {}): AgentConfigSnapshotSource {
  return {
    role: "developer",
    versions: { model: "model-override" },
    execution: {
      effectiveCapabilityIds: ["workspace.read", "workspace.search"],
      workspaceIdentity,
      policyIdentity,
    },
    ...overrides,
  };
}

/** Рекурсивно замораживает объект, чтобы доказать отсутствие мутаций у правил. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const selectedKnowledge: RoleSelectedKnowledge = {
  guidelines: [
    { kind: "guideline", id: "guideline-b", value: { priority: "p2" }, provenance: { id: "guideline-b", version: 2, digest } },
    { kind: "guideline", id: "guideline-a", value: { priority: "p1" }, provenance: { id: "guideline-a", version: 2, digest } },
    { kind: "guideline", id: "guideline-required", value: { priority: "p0" }, provenance: { id: "guideline-required", version: 2, digest } },
  ],
  decisions: [{ kind: "decision", id: "decision-1", value: {}, provenance: { id: "decision-1", version: null, digest } }],
  findings: [{ kind: "finding", id: "finding-open", value: {}, provenance: { id: "finding-open", version: null, digest } }],
  defects: [{ kind: "defect", id: "defect-open", value: {}, provenance: { id: "defect-open", version: null, digest } }],
};

function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id);
}

const roles: ContextManifestRoleV1[] = ["coordinator", "product_manager", "architect", "developer", "reviewer", "qa", "integration"];

describe("AgentConfigSnapshot", () => {
  it("собирает plain-data снимок из проверенного входа один раз", () => {
    const snapshot = createAgentConfigSnapshot(snapshotSource());
    expect(snapshot.permissions).toEqual(["workspace.read", "workspace.search"]);
    expect(snapshot.group).toBe("developer");
    expect(snapshot.modelOverride).toBe("model-override");
    expect(snapshot.isDev).toBe(false);
    expect(snapshot.workspaceId).toEqual(workspaceIdentity);
    expect(snapshot.policy.identity).toEqual(policyIdentity);
    expect(snapshot.policy.contextBudget).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.permissions)).toBe(true);
    expect(Object.isFrozen(snapshot.workspaceId)).toBe(true);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
  });

  it("включает проверенную политику бюджета в снимок, когда она задана", () => {
    const budget: ContextBudgetPolicyV1 = { version: 1, limit: 100 };
    const snapshot = createAgentConfigSnapshot(snapshotSource({ contextBudgetPolicy: budget }));
    expect(snapshot.policy.contextBudget).toEqual(budget);
    expect(Object.isFrozen(snapshot.policy.contextBudget)).toBe(true);
  });

  it("не мутирует входной объект и не разделяет изменяемые ссылки", () => {
    const source = deepFreeze(snapshotSource());
    const snapshot = createAgentConfigSnapshot(source);
    const after = createAgentConfigSnapshot(source);
    expect(snapshot).toEqual(after);
    expect(snapshot.workspaceId).not.toBe(source.execution.workspaceIdentity);
  });

  it("правила принимают только снимок и не обращаются к внешнему состоянию", () => {
    const snapshot = deepFreeze(createAgentConfigSnapshot(snapshotSource()));
    const knowledge = deepFreeze(selectedKnowledge);
    const first = selectRoleItems(snapshot, knowledge);
    const second = selectRoleItems(snapshot, knowledge);
    expect(second).toEqual(first);
    expect(ids(second)).toEqual(["guideline-a", "guideline-b", "guideline-required", "decision-1", "finding-open", "defect-open"]);
    expect(snapshot).toEqual(createAgentConfigSnapshot(snapshotSource()));
    expect(knowledge).toEqual(selectedKnowledge);
  });

  describe("assertSupportedBinding", () => {
    const bindings: Record<ContextSubjectV1["type"], ContextManifestRoleV1[]> = {
      TASK: ["developer", "reviewer", "qa", "integration"],
      EPIC: ["coordinator", "product_manager", "architect", "reviewer", "qa", "integration"],
      REQUEST: ["coordinator", "product_manager", "architect"],
    };

    it("разрешает только поддерживаемые связки subject/группа", () => {
      for (const subjectType of ["TASK", "EPIC", "REQUEST"] as const) {
        for (const role of roles) {
          const snapshot = createAgentConfigSnapshot(snapshotSource({ role }));
          if (bindings[subjectType].includes(role)) {
            expect(() => assertSupportedBinding(snapshot, subjectType)).not.toThrow();
          } else {
            expect(() => assertSupportedBinding(snapshot, subjectType)).toThrow(
              `UNSUPPORTED_RUN_SUBJECT_ROLE:${subjectType}:${role}`,
            );
          }
        }
      }
    });
  });

  describe("shouldSelectKnowledge", () => {
    it("выбирает knowledge только для групп developer/reviewer/qa", () => {
      for (const role of roles) {
        const snapshot = createAgentConfigSnapshot(snapshotSource({ role }));
        expect(shouldSelectKnowledge(snapshot)).toBe(role === "developer" || role === "reviewer" || role === "qa");
      }
    });
  });

  describe("selectRoleItems", () => {
    it("включает элементы по группе и сортирует по виду и id", () => {
      const developer = selectRoleItems(createAgentConfigSnapshot(snapshotSource()), selectedKnowledge);
      expect(ids(developer)).toEqual(["guideline-a", "guideline-b", "guideline-required", "decision-1", "finding-open", "defect-open"]);
      const reviewer = selectRoleItems(createAgentConfigSnapshot(snapshotSource({ role: "reviewer" })), selectedKnowledge);
      expect(ids(reviewer)).toEqual(["guideline-a", "guideline-b", "guideline-required", "decision-1", "finding-open"]);
      const qa = selectRoleItems(createAgentConfigSnapshot(snapshotSource({ role: "qa" })), selectedKnowledge);
      expect(ids(qa)).toEqual(["defect-open"]);
      for (const role of ["coordinator", "product_manager", "architect", "integration"] as const) {
        const none = selectRoleItems(createAgentConfigSnapshot(snapshotSource({ role })), selectedKnowledge);
        expect(ids(none)).toEqual([]);
      }
    });

    it("сокращает guideline по политике бюджета детерминированно и не мутирует вход", () => {
      const snapshot = deepFreeze(createAgentConfigSnapshot(snapshotSource({ contextBudgetPolicy: { version: 1, limit: 0 } })));
      const knowledge = deepFreeze(selectedKnowledge);
      const pruned = selectRoleItems(snapshot, knowledge);
      expect(ids(pruned)).toEqual(["guideline-required", "decision-1", "finding-open", "defect-open"]);
      expect(selectRoleItems(snapshot, knowledge)).toEqual(pruned);
      expect(knowledge).toEqual(selectedKnowledge);
      expect(snapshot.policy.contextBudget).toEqual({ version: 1, limit: 0 });
    });
  });

  describe("projectDeveloperWorkspace", () => {
    it("проецирует только безопасные label без credentials и полных путей", () => {
      const snapshot = createAgentConfigSnapshot(snapshotSource());
      const projection = projectDeveloperWorkspace(snapshot, "1".repeat(40), "master");
      expect(projection).toEqual({
        repository: "EbbRepo",
        workspace: "TASK-1",
        worktree: "TASK-1",
        targetHead: "1".repeat(40),
        targetBranch: "master",
      });
    });

    it("возвращает null для небезопасных или пустых label и пробрасывает null-цели", () => {
      const snapshot = createAgentConfigSnapshot(
        snapshotSource({
          execution: {
            effectiveCapabilityIds: [],
            workspaceIdentity: { repository: "", workspace: "C:/Users/alex1", worktree: "root" },
            policyIdentity,
          },
        }),
      );
      const projection = projectDeveloperWorkspace(snapshot, null, null);
      expect(projection).toEqual({ repository: null, workspace: null, worktree: null, targetHead: null, targetBranch: null });
    });
  });
});
