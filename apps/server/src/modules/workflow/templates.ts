/**
 * Built-in workflow templates.
 *
 * Each template defines the allowed stages and transitions for a particular
 * workflow type. The `standard` template covers the full standalone task
 * lifecycle; others provide simplified flows for common patterns.
 */

import type { WorkflowTemplate } from "./workflow-types.js";

/**
 * Standard standalone task workflow.
 *
 * Covers: DRAFT → READY → DEVELOPMENT → REVIEW → QA → INTEGRATION →
 * READY_FOR_MERGE → MERGING → DONE → RELEASED
 *
 * Also includes BLOCKED, WAITING_FOR_DEPENDENCY, WAITING_FOR_APPROVAL,
 * PAUSED, FAILED, and CANCELLED from any non-terminal state.
 */
export const standard: WorkflowTemplate = {
  name: "standard",
  description: "Standard standalone task lifecycle",
  stages: [
    "DRAFT",
    "READY",
    "DEVELOPMENT",
    "REVIEW",
    "QA",
    "READY_FOR_INTEGRATION",
    "INTEGRATION",
    "READY_FOR_MERGE",
    "MERGING",
    "DONE",
    "RELEASED",
    "BLOCKED",
    "WAITING_FOR_DEPENDENCY",
    "WAITING_FOR_APPROVAL",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
   transitions: [
     // Progression
     { from: "DRAFT", to: "READY" },
     { from: "READY", to: "DEVELOPMENT" },
     { from: "DEVELOPMENT", to: "REVIEW" },
     {
       from: "REVIEW",
       to: "QA",
       requires: ["hasReviewPassed"],
     },
     { from: "QA", to: "READY_FOR_INTEGRATION" },
     { from: "READY_FOR_INTEGRATION", to: "INTEGRATION" },
     { from: "INTEGRATION", to: "READY_FOR_MERGE" },
     {
       from: "READY_FOR_MERGE",
       to: "MERGING",
       requires: ["hasFinalMergeApproval"],
     },
     { from: "MERGING", to: "DONE" },
     { from: "DONE", to: "RELEASED" },

    // Integration skip (for tasks that don't need integration)
    { from: "READY_FOR_INTEGRATION", to: "READY_FOR_MERGE" },

    // Approval gates
    {
      from: "READY_FOR_MERGE",
      to: "MERGING",
      requires: ["hasFinalMergeApproval"],
    },
    {
      from: "DONE",
      to: "RELEASED",
    },

    // Flow-control states
    { from: "DRAFT", to: "BLOCKED" },
    { from: "READY", to: "BLOCKED" },
    { from: "DEVELOPMENT", to: "BLOCKED" },
    { from: "REVIEW", to: "BLOCKED" },
    { from: "QA", to: "BLOCKED" },

    { from: "DRAFT", to: "WAITING_FOR_DEPENDENCY" },
    { from: "READY", to: "WAITING_FOR_DEPENDENCY" },
    { from: "DEVELOPMENT", to: "WAITING_FOR_DEPENDENCY" },

    { from: "DRAFT", to: "WAITING_FOR_APPROVAL" },
    { from: "READY", to: "WAITING_FOR_APPROVAL" },

    { from: "DRAFT", to: "PAUSED" },
    { from: "READY", to: "PAUSED" },
    { from: "DEVELOPMENT", to: "PAUSED" },
    { from: "REVIEW", to: "PAUSED" },
    { from: "QA", to: "PAUSED" },

    { from: "DEVELOPMENT", to: "FAILED" },
    { from: "REVIEW", to: "FAILED" },
    { from: "QA", to: "FAILED" },

    // Resume from flow-control states
    { from: "BLOCKED", to: "READY" },
    { from: "WAITING_FOR_DEPENDENCY", to: "READY" },
    { from: "WAITING_FOR_APPROVAL", to: "READY" },
    { from: "PAUSED", to: "READY" },

    // Cancel from any non-terminal state
    { from: "DRAFT", to: "CANCELLED" },
    { from: "READY", to: "CANCELLED" },
    { from: "DEVELOPMENT", to: "CANCELLED" },
    { from: "REVIEW", to: "CANCELLED" },
    { from: "QA", to: "CANCELLED" },
    { from: "READY_FOR_INTEGRATION", to: "CANCELLED" },
    { from: "INTEGRATION", to: "CANCELLED" },
    { from: "READY_FOR_MERGE", to: "CANCELLED" },
    { from: "MERGING", to: "CANCELLED" },
    { from: "BLOCKED", to: "CANCELLED" },
    { from: "WAITING_FOR_DEPENDENCY", to: "CANCELLED" },
    { from: "WAITING_FOR_APPROVAL", to: "CANCELLED" },
    { from: "PAUSED", to: "CANCELLED" },
    { from: "FAILED", to: "CANCELLED" },
  ],
};

/**
 * Bugfix workflow – simplified lifecycle for hotfixes.
 *
 * Skips READY_FOR_INTEGRATION and INTEGRATION steps.
 * Goes QA → DONE → RELEASED directly.
 */
export const bugfix: WorkflowTemplate = {
  name: "bugfix",
  description: "Simplified lifecycle for bug fixes and hotfixes",
  stages: [
    "DRAFT",
    "READY",
    "DEVELOPMENT",
    "REVIEW",
    "QA",
    "DONE",
    "RELEASED",
    "BLOCKED",
    "CANCELLED",
  ],
  transitions: [
    { from: "DRAFT", to: "READY" },
    { from: "READY", to: "DEVELOPMENT" },
    { from: "DEVELOPMENT", to: "REVIEW" },
    { from: "REVIEW", to: "QA" },
    { from: "QA", to: "DONE" },
    { from: "DONE", to: "RELEASED" },

    { from: "DRAFT", to: "BLOCKED" },
    { from: "READY", to: "BLOCKED" },
    { from: "DEVELOPMENT", to: "BLOCKED" },

    { from: "BLOCKED", to: "READY" },

    { from: "DRAFT", to: "CANCELLED" },
    { from: "READY", to: "CANCELLED" },
    { from: "DEVELOPMENT", to: "CANCELLED" },
    { from: "REVIEW", to: "CANCELLED" },
    { from: "QA", to: "CANCELLED" },
  ],
};

/**
 * Architecture change workflow.
 *
 * Used for epic-child tasks. Includes INTEGRATED_INTO_EPIC stage
 * and requires integration + parent epic release for certain transitions.
 */
export const architecture_change: WorkflowTemplate = {
  name: "architecture_change",
  description: "Workflow for epic-child tasks requiring integration markers",
  stages: [
    "DRAFT",
    "READY",
    "DEVELOPMENT",
    "REVIEW",
    "QA",
    "READY_FOR_INTEGRATION",
    "INTEGRATION",
    "INTEGRATED_INTO_EPIC",
    "READY_FOR_MERGE",
    "MERGING",
    "DONE",
    "RELEASED",
    "BLOCKED",
    "WAITING_FOR_DEPENDENCY",
    "WAITING_FOR_APPROVAL",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
  transitions: [
    // Progression
    { from: "DRAFT", to: "READY" },
    { from: "READY", to: "DEVELOPMENT" },
    { from: "DEVELOPMENT", to: "REVIEW" },
    { from: "REVIEW", to: "QA" },
    { from: "QA", to: "READY_FOR_INTEGRATION" },
    { from: "READY_FOR_INTEGRATION", to: "INTEGRATION" },
    {
      from: "INTEGRATION",
      to: "INTEGRATED_INTO_EPIC",
      requires: ["hasSuccessfulIntegration"],
    },
    { from: "INTEGRATED_INTO_EPIC", to: "READY_FOR_MERGE" },
    {
      from: "READY_FOR_MERGE",
      to: "MERGING",
      requires: ["hasFinalMergeApproval"],
    },
    { from: "MERGING", to: "DONE" },
    {
      from: "DONE",
      to: "RELEASED",
      requires: ["parentEpicReleased"],
    },

    // Flow-control
    { from: "DRAFT", to: "BLOCKED" },
    { from: "READY", to: "BLOCKED" },
    { from: "DEVELOPMENT", to: "BLOCKED" },
    { from: "REVIEW", to: "BLOCKED" },
    { from: "QA", to: "BLOCKED" },

    { from: "DRAFT", to: "WAITING_FOR_DEPENDENCY" },
    { from: "READY", to: "WAITING_FOR_DEPENDENCY" },
    { from: "DEVELOPMENT", to: "WAITING_FOR_DEPENDENCY" },

    { from: "DRAFT", to: "WAITING_FOR_APPROVAL" },
    { from: "READY", to: "WAITING_FOR_APPROVAL" },

    { from: "DRAFT", to: "PAUSED" },
    { from: "READY", to: "PAUSED" },
    { from: "DEVELOPMENT", to: "PAUSED" },
    { from: "REVIEW", to: "PAUSED" },
    { from: "QA", to: "PAUSED" },

    { from: "DEVELOPMENT", to: "FAILED" },
    { from: "REVIEW", to: "FAILED" },
    { from: "QA", to: "FAILED" },

    // Resume
    { from: "BLOCKED", to: "READY" },
    { from: "WAITING_FOR_DEPENDENCY", to: "READY" },
    { from: "WAITING_FOR_APPROVAL", to: "READY" },
    { from: "PAUSED", to: "READY" },

    // Cancel
    { from: "DRAFT", to: "CANCELLED" },
    { from: "READY", to: "CANCELLED" },
    { from: "DEVELOPMENT", to: "CANCELLED" },
    { from: "REVIEW", to: "CANCELLED" },
    { from: "QA", to: "CANCELLED" },
    { from: "READY_FOR_INTEGRATION", to: "CANCELLED" },
    { from: "INTEGRATION", to: "CANCELLED" },
    { from: "INTEGRATED_INTO_EPIC", to: "CANCELLED" },
    { from: "READY_FOR_MERGE", to: "CANCELLED" },
    { from: "MERGING", to: "CANCELLED" },
    { from: "BLOCKED", to: "CANCELLED" },
    { from: "WAITING_FOR_DEPENDENCY", to: "CANCELLED" },
    { from: "WAITING_FOR_APPROVAL", to: "CANCELLED" },
    { from: "PAUSED", to: "CANCELLED" },
    { from: "FAILED", to: "CANCELLED" },
  ],
};

/**
 * Documentation workflow – lightweight lifecycle for doc-only tasks.
 */
export const documentation: WorkflowTemplate = {
  name: "documentation",
  description: "Lightweight lifecycle for documentation tasks",
  stages: [
    "DRAFT",
    "READY",
    "DEVELOPMENT",
    "REVIEW",
    "DONE",
    "RELEASED",
    "BLOCKED",
    "PAUSED",
    "CANCELLED",
  ],
  transitions: [
    { from: "DRAFT", to: "READY" },
    { from: "READY", to: "DEVELOPMENT" },
    { from: "DEVELOPMENT", to: "REVIEW" },
    { from: "REVIEW", to: "DONE" },
    { from: "DONE", to: "RELEASED" },

    { from: "DRAFT", to: "BLOCKED" },
    { from: "READY", to: "BLOCKED" },
    { from: "DEVELOPMENT", to: "BLOCKED" },

    { from: "BLOCKED", to: "READY" },

    { from: "DRAFT", to: "PAUSED" },
    { from: "READY", to: "PAUSED" },
    { from: "DEVELOPMENT", to: "PAUSED" },

    { from: "PAUSED", to: "READY" },

    { from: "DRAFT", to: "CANCELLED" },
    { from: "READY", to: "CANCELLED" },
    { from: "DEVELOPMENT", to: "CANCELLED" },
    { from: "REVIEW", to: "CANCELLED" },
    { from: "PAUSED", to: "CANCELLED" },
  ],
};

/**
 * DevOps workflow – lifecycle for infrastructure and deployment tasks.
 *
 * Includes QA and integration steps with approval gates.
 */
export const devops: WorkflowTemplate = {
  name: "devops",
  description: "Lifecycle for infrastructure and deployment tasks",
  stages: [
    "DRAFT",
    "READY",
    "DEVELOPMENT",
    "REVIEW",
    "QA",
    "READY_FOR_INTEGRATION",
    "INTEGRATION",
    "READY_FOR_MERGE",
    "MERGING",
    "DONE",
    "RELEASED",
    "BLOCKED",
    "WAITING_FOR_APPROVAL",
    "CANCELLED",
  ],
  transitions: [
    { from: "DRAFT", to: "READY" },
    { from: "READY", to: "DEVELOPMENT" },
    { from: "DEVELOPMENT", to: "REVIEW" },
    { from: "REVIEW", to: "QA" },
    { from: "QA", to: "READY_FOR_INTEGRATION" },
    { from: "READY_FOR_INTEGRATION", to: "INTEGRATION" },
    { from: "INTEGRATION", to: "READY_FOR_MERGE" },
    {
      from: "READY_FOR_MERGE",
      to: "MERGING",
      requires: ["hasFinalMergeApproval"],
    },
    { from: "MERGING", to: "DONE" },
    { from: "DONE", to: "RELEASED" },

    { from: "DRAFT", to: "BLOCKED" },
    { from: "READY", to: "BLOCKED" },
    { from: "DEVELOPMENT", to: "BLOCKED" },
    { from: "REVIEW", to: "BLOCKED" },
    { from: "QA", to: "BLOCKED" },

    { from: "DRAFT", to: "WAITING_FOR_APPROVAL" },
    { from: "READY", to: "WAITING_FOR_APPROVAL" },

    { from: "BLOCKED", to: "READY" },
    { from: "WAITING_FOR_APPROVAL", to: "READY" },

    { from: "DRAFT", to: "CANCELLED" },
    { from: "READY", to: "CANCELLED" },
    { from: "DEVELOPMENT", to: "CANCELLED" },
    { from: "REVIEW", to: "CANCELLED" },
    { from: "QA", to: "CANCELLED" },
    { from: "READY_FOR_INTEGRATION", to: "CANCELLED" },
    { from: "INTEGRATION", to: "CANCELLED" },
    { from: "READY_FOR_MERGE", to: "CANCELLED" },
    { from: "MERGING", to: "CANCELLED" },
  ],
};

/**
 * All built-in templates keyed by name.
 */
export const templates = {
  standard,
  bugfix,
  architecture_change,
  documentation,
  devops,
} as const;
