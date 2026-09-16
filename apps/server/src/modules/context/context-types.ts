/**
 * Context Package and Manifest types for Orchestrator Hermes.
 * Defines the structure for context packages sent to Agent roles.
 */

/** Priority level for context items */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/** Task Contract - core requirements and constraints */
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

/** Status for findings */
export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** Status for defects */
export type DefectStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

/** Status for guidelines */
export type GuidelineStatus = 'active' | 'inactive' | 'deprecated';

/** Status for decisions */
export type DecisionStatus = 'accepted' | 'rejected' | 'superseded';

/** Severity for findings */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Finding from Review/QA */
export interface Finding {
  id: string;
  status: FindingStatus;
  title: string;
  severity: FindingSeverity;
  description?: string;
  location?: string;
}

/** Defect from QA */
export interface Defect {
  id: string;
  status: DefectStatus;
  title: string;
  description?: string;
  stepsToReproduce?: string;
}

/** Guideline - project rule */
export interface Guideline {
  id: string;
  category: string;
  status: GuidelineStatus;
  text: string;
  priority?: Priority;
  scope?: string;
  applicableRoles?: string[];
}

/** Decision - architectural choice */
export interface Decision {
  id: string;
  status: DecisionStatus;
  text: string;
  scope?: 'PROJECT' | 'AREA' | 'EPIC' | 'TASK';
  rationale?: string;
}

/** Developer session transcript */
export type Message = {
  role: 'user' | 'assistant';
  content: string;
};

/** Workspace metadata */
export interface WorkspaceMeta {
  repoPath: string;
  branch: string;
  commitHash: string;
}

/** Budget configuration */
export interface BudgetConfig {
  limit: number;
  priority: Priority;
}

/**
 * Developer Context Package
 * Contains all context needed by Developer role.
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
 * Reviewer Context Package
 * Contains all context needed by Reviewer role.
 * Does NOT include Developer conversation.
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
 * Context Manifest - tracks what went into a context package
 * Persists IDs and versions, NOT secrets.
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
 * Context Delta - changes from previous context
 */
export interface ContextDelta {
  added: string[];
  updated: string[];
  removed: string[];
}
