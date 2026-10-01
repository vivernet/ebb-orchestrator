/**
 * Контекст Package and Manifest types for Orchestrator Hermes.
 * Определяет the structure for context packages sent to Agent roles.
 */

/** Уровень приоритета для контекст элементы */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/**
 * Доверенная versioned policy детерминированного pruning selected Guidelines.
 * `limit` управляет существующими structural priority tiers и не является точным
 * token count или обещанием fit; policy передаёт только внутренний caller.
 */
export interface ContextBudgetPolicyV1 {
  /** Единственная версия policy, поддерживаемая текущим assembler. */
  version: 1;
  /** Неотрицательный integer для существующих ContextBudget priority tiers. */
  limit: number;
}

/** задача Contract - основные требования и ограничения */
export interface TaskContract {
  id: string;
  goal: string;
  context: string;
  requirements: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  nonGoals: string[];
  definitionOfDone: string[];
  priority: Priority;
}

/** Точная versioned форма контракта, сохраняемая в `tasks.contract_json` и `epics.contract_json`. */
export interface PersistedWorkTaskContractV1 {
  version: number;
  goal: string;
  context: string;
  requirements: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
  nonGoals: string[];
  definitionOfDone: string[];
}

/** Состояние for findings */
export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** Состояние for defects */
export type DefectStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** Состояние for guidelines */
export type GuidelineStatus = 'active' | 'inactive' | 'deprecated';

/** Состояние for decisions */
export type DecisionStatus = 'accepted' | 'rejected' | 'superseded';

/** Severity для findings */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Finding из Review/QОбъект */
export interface Finding {
  id: string;
  status: FindingStatus;
  title: string;
  severity: FindingSeverity;
  description?: string;
  location?: string;
}

/** Defect из QОбъект */
export interface Defect {
  id: string;
  status: DefectStatus;
  title: string;
  description?: string;
  stepsToReproduce?: string;
}

/** Guideline - проект rule */
export interface Guideline {
  id: string;
  category: string;
  status: GuidelineStatus;
  text: string;
  priority?: Priority;
  scope?: string;
  applicableRoles?: string[];
}

/** Решение — архитектурный выбор. */
export interface Decision {
  id: string;
  status: DecisionStatus;
  text: string;
  scope?: 'PROJECT' | 'AREA' | 'EPIC' | 'TASK';
  rationale?: string;
}

/**
 * Безопасная ссылка на выбранный элемент контекста.
 * Хранит только идентификатор, известную целочисленную версию и SHA-256 digest;
 * `null` означает, что историческое значение достоверно неизвестно.
 */
export interface ContextItemProvenance {
  id: string;
  version: number | null;
  digest: string | null;
}

/** Идентификатор subject, contract/request которого связан с Run fingerprint. */
export type ContextSubjectTypeV1 = 'TASK' | 'EPIC' | 'REQUEST';

/**
 * Идентификаторы расположения repository, workspace и worktree для Run fingerprint.
 * Полные path values нормализуются внутри server digest builder и участвуют только
 * в хешировании; Developer prompt может получить лишь безопасные basename labels,
 * а ContextManifest API DTO не содержит ни path values, ни этих labels. Неизвестное — `null`.
 */
export interface ContextWorkspaceIdentityV1 {
  repository: string | null;
  workspace: string | null;
  worktree: string | null;
}

/**
 * Идентификаторы выбранных provider, runtime и связанных policy для Run fingerprint.
 * Поля предназначены для идентификаторов конфигурации, а не credentials; исходные
 * значения участвуют в хешировании и не входят в API DTO.
 */
export interface ContextPolicyIdentityV1 {
  providerId: string | null;
  providerPolicyId: string | null;
  runtimeId: string | null;
  runtimePolicyId: string | null;
}

/**
 * Полный набор подготовленных входов и execution boundary для Run context fingerprint.
 * Неизвестные исторические версии и digest передаются как `null`, а не заменяются
 * предположениями; digest builder сортирует `items` и `effectiveCapabilityIds` и нормализует
 * `workspaceIdentity` перед хешированием. Изменение любого учитываемого значения меняет
 * fingerprint, используемый при проверке возможности resume.
 */
export interface ContextFingerprintInputV1 {
  promptHash: string;
  subjectType: ContextSubjectTypeV1;
  subjectId: string;
  contractOrRequestDigest: string | null;
  items: readonly ContextItemProvenance[];
  contextBuilderVersion: string | null;
  role: string;
  roleVersion: string | null;
  runtime: string | null;
  runtimeVersion: string | null;
  model: string | null;
  modelVersion: string | null;
  outputSchemaVersion: string | null;
  contextVersion: string | null;
  workspaceIdentity: ContextWorkspaceIdentityV1;
  targetHead: string | null;
  targetBranch: string | null;
  effectiveCapabilityIds: readonly string[];
  projectConfigRevisionId: string | null;
  projectConfigHash: string | null;
  policyIdentity: ContextPolicyIdentityV1;
}

/**
 * Точный набор сохранённых полей Request, из которого строится digest версии 1.
 * `id`, `project_id` и исходный `request` образуют проверяемую идентичность запроса;
 * остальные колонки базы данных в digest не входят.
 */
export interface RequestProvenancePayloadV1 {
  id: string;
  project_id: string;
  request: string;
}

/**
 * Точный набор сохранённых полей Decision, включённый в provenance digest версии 1.
 * `related_guideline` содержит ссылку на guideline либо `null`; поля вне этого набора
 * не участвуют в сравнении provenance.
 */
export interface DecisionProvenancePayloadV1 {
  id: string;
  status: string;
  scope: string;
  title: string;
  rationale: string;
  related_guideline: string | null;
  content: string;
}

/**
 * Набор сохранённых полей Guideline для provenance digest версии 1.
 * Digest учитывает версию, статус, область, роли и `content_hash`, но не текст guideline
 * и не путь к его файлу.
 */
export interface GuidelineProvenancePayloadV1 {
  id: string;
  version: number;
  status: string;
  scope: string;
  applicable_roles: string;
  content_hash: string;
}

/**
 * Минимальный набор полей Finding, учитываемых для выбранной роли в provenance digest.
 * `guideline_ref` содержит ссылку на guideline либо `null`; остальные поля записи не входят
 * в payload и не влияют на сравнение.
 */
export interface FindingProvenancePayloadV1 {
  id: string;
  status: string;
  title: string;
  description: string;
  guideline_ref: string | null;
}

/**
 * Минимальный набор полей Defect, учитываемых для выбранной роли в provenance digest.
 * `acceptance_criterion_ref` содержит ссылку на критерий приёмки либо `null`; остальные
 * поля записи в payload не включаются.
 */
export interface DefectProvenancePayloadV1 {
  id: string;
  status: string;
  title: string;
  description: string;
  acceptance_criterion_ref: string | null;
}

/** Developer сессия transcript */
export type Message = {
  role: 'user' | 'assistant';
  content: string;
};

/** Workspace metadatОбъект */
export interface WorkspaceMeta {
  repoPath: string;
  branch: string;
  commitHash: string;
}

/** Budget конфигурация */
export interface BudgetConfig {
  limit: number;
  priority: Priority;
}

/**
 * Developer контекст Package
 * Содержит all context needed by Developer role.
 */
export interface DeveloperContextPackage {
  taskContract: TaskContract;
  findings?: Finding[];
  defects?: Defect[];
  guidelines?: Guideline[];
  decisions?: Decision[];
  workspaceMeta?: WorkspaceMeta;
  sessionTranscript?: Message[];
  dependencyState?: string;
}

/**
 * Reviewer контекст Package
 * Содержит all context needed by Reviewer role.
 * не include Developer conversation.
 */
export interface ReviewerContextPackage {
  taskContract: TaskContract;
  gitDiff?: string;
  checks?: string[];
  guidelines?: Guideline[];
  decisions?: Decision[];
  findings?: Finding[];  // Only relevant findings during re-review
  sessionTranscript?: never;  // Explicitly excluded
}

/**
 * Контекст Manifest - tracks what went into a context package
 * Сохраняет IDs and versions, NOT secrets.
 */
export interface ContextManifest {
  runId: string;
  taskId: string;
  role: 'developer' | 'reviewer' | 'qa' | 'integration' | 'architect';
  taskContractVersion: string;
  guidelineIds: string[];
  decisionIds: string[];
  findingIds: string[];
  defectIds: string[];
  contextBuilderVersion: string;
  initialTokenSize?: number;
  createdAt: string;
}

/**
 * Версионированный манифест состава контекста с provenance контракта и выбранных элементов.
 * Сохраняет их ID и известные version/digest; исторически неизвестные значения и точное
 * число токенов представлены как `null`. Полный текст контракта и элементов не включается.
 */
export interface ContextManifestV1 extends Omit<ContextManifest, 'initialTokenSize'> {
  /** Null обозначает, что точный digest контракта неизвестен. */
  taskContractDigest: string | null;
  /** Точное число токенов либо null, если измерение недоступно. */
  initialTokenSize: number | null;
  /** Builder сохраняет неизвестные version/digest как null, не подменяя их пустым context. */
  guidelineProvenance: ContextItemProvenance[];
  decisionProvenance: ContextItemProvenance[];
  findingProvenance: ContextItemProvenance[];
  defectProvenance: ContextItemProvenance[];
}

/** Поддерживаемые роли новых subject-bound Run manifests. */
export type ContextManifestRoleV1 =
  | 'coordinator'
  | 'product_manager'
  | 'architect'
  | 'developer'
  | 'reviewer'
  | 'qa'
  | 'integration';

/** Типизированная идентичность единственного subject, к которому привязан Run. */
export interface ContextSubjectV1 {
  type: ContextSubjectTypeV1;
  id: string;
}

/**
 * Неизменяемые входы для записи нового Run manifest в той же SQLite transaction,
 * что и Run. Полный prompt передаётся лишь для проверки его точного hash и не сохраняется
 * в provenance-таблице.
 */
export interface PreparedRunContext {
  finalPrompt: string;
  subject: ContextSubjectV1;
  role: ContextManifestRoleV1;
  contractDigest: string | null;
  items: readonly ContextItemProvenance[];
  contextBuilderVersion: string;
  promptHash: string;
  contextHash: string;
  initialTokenSize: number | null;
  workspaceFingerprint: string;
}

/** Безопасная persisted-проекция v2 без prompt, контракта или полного контекста. */
export interface ContextManifestV2 {
  id: string;
  runId: string;
  subject: ContextSubjectV1;
  role: ContextManifestRoleV1;
  contractRequestDigest: string | null;
  items: ContextItemProvenance[];
  promptHash: string;
  contextHash: string;
  contextBuilderVersion: string;
  initialTokenSize: number | null;
  createdAt: string;
}

/** Safe-availability результата чтения без ложного утверждения о пустом legacy-контексте. */
export type ContextManifestReadResult =
  | { availability: 'available'; manifest: ContextManifestV2 }
  | {
      availability: 'unavailable';
      reason: 'LEGACY_PROVENANCE_UNAVAILABLE' | 'INVALID_PERSISTED_PROVENANCE';
    };

/**
 * Контекст Delta - changes from previous context
 */
export interface ContextDelta {
  added: string[];
  updated: string[];
  removed: string[];
}
