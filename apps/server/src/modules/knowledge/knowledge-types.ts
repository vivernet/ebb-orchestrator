/**
 * Knowledge domain types – Guidelines and Decisions.
 */

// ── Guideline types ──────────────────────────────────────────────────

export type GuidelinePriority = "REQUIRED" | "RECOMMENDED" | "PREFERENCE";

export type GuidelineStatus =
  | "PROPOSED"
  | "UNDER_REVIEW"
  | "ACTIVE"
  | "SUPERSEDED"
  | "DEPRECATED"
  | "REJECTED"
  | "PENDING_EXTERNAL_CHANGE";

export type KnowledgeScope = "project" | "area" | "path";

export interface GuidelineRecord {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: string;
  readonly category: string;
  readonly version: number;
  readonly priority: GuidelinePriority;
  readonly status: GuidelineStatus;
  readonly scope: string;
  readonly applicableRoles: readonly string[];
  readonly rationale: string;
  readonly provenance: string;
  readonly contentHash: string;
  readonly supersededBy: string | null;
  readonly content: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedGuideline {
  id: string;
  category: string;
  version: number;
  priority: GuidelinePriority;
  status: GuidelineStatus;
  scope: string;
  applicableRoles: string[];
  rationale: string;
  provenance: string;
  contentHash: string;
  supersededBy: string | null;
  content: string;
}

// ── Decision types ───────────────────────────────────────────────────

export type DecisionStatus =
  | "PROPOSED"
  | "ACCEPTED"
  | "SUPERSEDED"
  | "OBSOLETE"
  | "REJECTED";

export type DecisionScope = "PROJECT" | "AREA" | "EPIC" | "TASK";

export interface DecisionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: string;
  readonly status: DecisionStatus;
  readonly scope: DecisionScope;
  readonly title: string;
  readonly rationale: string;
  readonly relatedGuideline: string | null;
  readonly content: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedDecision {
  id: string;
  status: DecisionStatus;
  scope: DecisionScope;
  title: string;
  rationale: string;
  relatedGuideline: string | null;
  content: string;
}

// ── Index result ─────────────────────────────────────────────────────

export interface IndexResult {
  guidelinesIndexed: number;
  decisionsIndexed: number;
}

// ── Active scope filter ──────────────────────────────────────────────

export interface ScopeFilter {
  scope?: string;
  role?: string;
  category?: string;
}

// ── Guideline status transition map ──────────────────────────────────

export const GUIDELINE_STATUS_TRANSITIONS: Record<GuidelineStatus, readonly GuidelineStatus[]> = {
  PROPOSED: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["ACTIVE", "REJECTED"],
  ACTIVE: ["SUPERSEDED", "DEPRECATED"],
  SUPERSEDED: [],
  DEPRECATED: [],
  REJECTED: [],
  PENDING_EXTERNAL_CHANGE: ["ACTIVE", "UNDER_REVIEW", "REJECTED"],
};

export const DECISION_STATUS_TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  PROPOSED: ["ACCEPTED", "REJECTED"],
  ACCEPTED: ["SUPERSEDED", "OBSOLETE"],
  SUPERSEDED: [],
  OBSOLETE: [],
  REJECTED: [],
};
