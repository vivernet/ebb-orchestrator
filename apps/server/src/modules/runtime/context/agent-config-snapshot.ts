/**
 * Снимок конфигурации агента (AgentConfigSnapshot).
 *
 * Паттерн «сбор контекста один раз»: весь читаемый контекст, нужный правилам
 * сборки Run-контекста, собирается один раз в намеренно plain-data объект.
 * Правила — чистые функции от снимка: они не обращаются к БД, глобальному
 * состоянию или клиентским хранилищам (Zustand) и не имеют побочных эффектов.
 *
 * Снимок неизменяем (замораживается при создании) и не разделяет изменяемые
 * ссылки с входом сборщика: правила не могут мутировать ни снимок, ни объекты
 * вызывающего кода. Поля, у которых пока нет production-источника (например,
 * `isDev`), включены в контракт как зарезервированные и не влияют на поведение.
 */

import { ContextBudget } from "../../context/context-budget.js";
import type {
  ContextBudgetPolicyV1,
  ContextItemProvenance,
  ContextManifestRoleV1,
  ContextPolicyIdentityV1,
  ContextSubjectV1,
  ContextWorkspaceIdentityV1,
  Priority,
} from "../../context/context-types.js";

/** Политики Run, влияющие на правила сборки контекста. */
export interface AgentConfigSnapshotPolicy {
  /** Проверенная политика бюджета контекста; отсутствует, если caller не задал. */
  readonly contextBudget?: ContextBudgetPolicyV1;
  /** Идентификаторы выбранных provider/runtime и связанных политик. */
  readonly identity: ContextPolicyIdentityV1;
}

/**
 * Неизменяемый plain-data снимок конфигурации агента.
 * Все поля собираются один раз из проверенного входа и участвуют в правилах.
 */
export interface AgentConfigSnapshot {
  /** Права агента — проверенные capability ids запущенного Run. */
  readonly permissions: readonly string[];
  /** Группа агента — роль Run, определяющая набор правил сборки контекста. */
  readonly group: ContextManifestRoleV1;
  /** Переопределение модели; null — модель по умолчанию группы. */
  readonly modelOverride: string | null;
  /**
   * Режим разработки. В текущей версии всегда false: явный сигнал dev-режима
   * отсутствует в v1 scope. Поле включено в контракт для стабильности правил.
   */
  readonly isDev: boolean;
  /** Идентичность workspace, к которому привязан Run. */
  readonly workspaceId: ContextWorkspaceIdentityV1;
  /** Политики Run, используемые правилами. */
  readonly policy: AgentConfigSnapshotPolicy;
}

/** Минимальный проверенный вход сборщика снимка (структурно совместим с PrepareRunContextInput). */
export interface AgentConfigSnapshotSource {
  readonly role: ContextManifestRoleV1;
  readonly versions: { readonly model: string | null };
  readonly contextBudgetPolicy?: ContextBudgetPolicyV1;
  readonly execution: {
    readonly effectiveCapabilityIds: readonly string[];
    readonly workspaceIdentity: ContextWorkspaceIdentityV1;
    readonly policyIdentity: ContextPolicyIdentityV1;
  };
}

/**
 * Собирает неизменяемый снимок конфигурации агента.
 * Не обращается к БД и не мутирует вход: массивы и объекты копируются,
 * копии замораживаются. Вызывается ровно один раз за подготовку контекста.
 *
 * @param source Проверенный вход подготовки Run-контекста.
 * @returns Замороженный plain-data снимок.
 */
export function createAgentConfigSnapshot(source: AgentConfigSnapshotSource): AgentConfigSnapshot {
  const workspaceId: ContextWorkspaceIdentityV1 = {
    repository: source.execution.workspaceIdentity.repository,
    workspace: source.execution.workspaceIdentity.workspace,
    worktree: source.execution.workspaceIdentity.worktree,
  };
  const identity: ContextPolicyIdentityV1 = {
    providerId: source.execution.policyIdentity.providerId,
    providerPolicyId: source.execution.policyIdentity.providerPolicyId,
    runtimeId: source.execution.policyIdentity.runtimeId,
    runtimePolicyId: source.execution.policyIdentity.runtimePolicyId,
  };
  const policy: AgentConfigSnapshotPolicy = {
    identity,
    ...(source.contextBudgetPolicy !== undefined
      ? { contextBudget: Object.freeze({ version: source.contextBudgetPolicy.version, limit: source.contextBudgetPolicy.limit }) }
      : {}),
  };
  return Object.freeze({
    permissions: Object.freeze([...source.execution.effectiveCapabilityIds]),
    group: source.role,
    modelOverride: source.versions.model,
    isDev: false,
    workspaceId: Object.freeze(workspaceId),
    policy: Object.freeze(policy),
  });
}

/** Элемент знания, над которым работают правила включения. */
export interface SnapshotRuleItem {
  readonly kind: "guideline" | "decision" | "finding" | "defect";
  readonly id: string;
  readonly value: unknown;
  readonly provenance: ContextItemProvenance;
}

/** Guideline с известным приоритетом для правила бюджета. */
export type SnapshotRuleGuideline = SnapshotRuleItem & {
  readonly kind: "guideline";
  readonly value: { readonly priority?: Priority };
};

/** Уже выбранное (собранное) знание, передаваемое правилам включения. */
export interface RoleSelectedKnowledge {
  readonly guidelines: readonly SnapshotRuleGuideline[];
  readonly decisions: readonly SnapshotRuleItem[];
  readonly findings: readonly SnapshotRuleItem[];
  readonly defects: readonly SnapshotRuleItem[];
}

/** Допустимые связки subject/группа для сборки контекста. */
const SUPPORTED_BINDINGS: Record<ContextSubjectV1["type"], readonly ContextManifestRoleV1[]> = {
  TASK: ["developer", "reviewer", "qa", "integration"],
  EPIC: ["coordinator", "product_manager", "architect", "reviewer", "qa", "integration"],
  REQUEST: ["coordinator", "product_manager", "architect"],
};

/**
 * Правило допустимой связки subject и группы агента.
 * Чистая функция от снимка; бросает ту же ошибку, что и прежняя проверка.
 *
 * @param snapshot Снимок конфигурации агента.
 * @param subjectType Тип subject Run.
 * @throws {Error} Если связка не поддерживается.
 */
export function assertSupportedBinding(snapshot: AgentConfigSnapshot, subjectType: ContextSubjectV1["type"]): void {
  if (!SUPPORTED_BINDINGS[subjectType].includes(snapshot.group)) {
    throw new Error(`UNSUPPORTED_RUN_SUBJECT_ROLE:${subjectType}:${snapshot.group}`);
  }
}

/** Группы, для которых выполняется выбор knowledge-элементов. */
const KNOWLEDGE_GROUPS = new Set<ContextManifestRoleV1>(["developer", "reviewer", "qa"]);

/**
 * Правило выбора knowledge: true только для групп, которым нужны элементы знания.
 * Чистая функция от снимка.
 */
export function shouldSelectKnowledge(snapshot: AgentConfigSnapshot): boolean {
  return KNOWLEDGE_GROUPS.has(snapshot.group);
}

/**
 * Правило включения элементов знания в prompt: группа определяет набор видов,
 * политика бюджета — выжившие guideline. Результат детерминирован и отсортирован
 * по виду, затем по id. Чистая функция от снимка и переданного знания; входные
 * массивы не мутируют (копии сортируются).
 */
export function selectRoleItems(snapshot: AgentConfigSnapshot, selected: RoleSelectedKnowledge): SnapshotRuleItem[] {
  const include: SnapshotRuleItem[] =
    snapshot.group === "developer"
      ? [...selected.guidelines, ...selected.decisions, ...selected.findings, ...selected.defects]
      : snapshot.group === "reviewer"
        ? [...selected.guidelines, ...selected.decisions, ...selected.findings]
        : snapshot.group === "qa"
          ? [...selected.defects]
          : [];
  const budget = snapshot.policy.contextBudget;
  const survivingGuidelines = budget === undefined
    ? null
    : new Set(new ContextBudget().pruneByBudget(
      selected.guidelines.map(({ id, value }) => ({ id, ...(value.priority !== undefined ? { priority: value.priority } : {}) })),
      budget.limit,
    ).map(({ id }) => id));
  const retained = survivingGuidelines === null
    ? include
    : include.filter((item) => item.kind !== "guideline" || survivingGuidelines.has(item.id));
  const kindOrder = { guideline: 0, decision: 1, finding: 2, defect: 3 };
  return retained.sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || compare(left.id, right.id));
}

/**
 * Правило безопасной проекции workspace для Developer: возвращает только leaf
 * label; абсолютные пути, URL authority/credentials и query не попадают в prompt.
 * Чистая функция от снимка и execution-целей.
 */
export function projectDeveloperWorkspace(
  snapshot: AgentConfigSnapshot,
  targetHead: string | null,
  targetBranch: string | null,
): { repository: string | null; workspace: string | null; worktree: string | null; targetHead: string | null; targetBranch: string | null } {
  return {
    repository: safeWorkspaceLabel(snapshot.workspaceId.repository),
    workspace: safeWorkspaceLabel(snapshot.workspaceId.workspace),
    worktree: safeWorkspaceLabel(snapshot.workspaceId.worktree),
    targetHead,
    targetBranch,
  };
}

/** Возвращает безопасный leaf label; абсолютный путь, URL authority/credentials и query не попадают в prompt. */
function safeWorkspaceLabel(identity: string | null): string | null {
  if (identity === null) return null;
  const normalized = identity.replace(/\\/g, "/");
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    try {
      path = new URL(normalized).pathname;
    } catch {
      return null;
    }
  } else {
    path = normalized.split(/[?#]/, 1)[0] ?? "";
  }
  const segments = path.split("/").filter(Boolean);
  const label = segments[segments.length - 1];
  if (!label || /^[a-zA-Z]:$/.test(label)) return null;
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const homeIndex = lowerSegments.findIndex((segment) => segment === "users" || segment === "home");
  if ((homeIndex >= 0 && homeIndex === segments.length - 2) || (segments.length === 1 && label.toLowerCase() === "root")) return null;
  return label;
}

/** Лексикографическое сравнение без зависимости от локали. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
