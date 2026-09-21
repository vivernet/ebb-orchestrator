/**
 * Контекст Package and Manifest types for Orchestrator Hermes.
 * Определяет the structure for context packages sent to Agent roles.
 */

/** Уровень приоритета для контекст элементы */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

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
 * Контекст Delta - changes from previous context
 */
export interface ContextDelta {
  added: string[];
  updated: string[];
  removed: string[];
}
