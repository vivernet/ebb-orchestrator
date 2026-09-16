/**
 * Progress fingerprinting - extracts stage-specific evidence for loop detection.
 */

import { createHash } from "node:crypto";
import type { ProgressFingerprint } from "./recovery-types.js";

/**
 * Generates a hash from evidence content.
 */
export function createEvidenceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Extracts evidence from review output for fingerprinting.
 */
export function extractReviewEvidence(reviewOutput: string): string {
  // Normalize and extract key findings
  return reviewOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Extracts evidence from QA output for fingerprinting.
 */
export function extractQAEvidence(qaOutput: string): string {
  // Normalize and extract key findings
  return qaOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Extracts evidence from integration output for fingerprinting.
 */
export function extractIntegrationEvidence(integrationOutput: string): string {
  // Normalize and extract key findings
  return integrationOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Creates a progress fingerprint for review stage.
 */
export function createReviewFingerprint(
  reviewOutput: string,
  timestamp: string,
): ProgressFingerprint {
  return {
    stage: "review",
    evidenceHash: createEvidenceHash(extractReviewEvidence(reviewOutput)),
    recordedAt: timestamp,
  };
}

/**
 * Creates a progress fingerprint for QA stage.
 */
export function createQAFingerprint(
  qaOutput: string,
  timestamp: string,
): ProgressFingerprint {
  return {
    stage: "qa",
    evidenceHash: createEvidenceHash(extractQAEvidence(qaOutput)),
    recordedAt: timestamp,
  };
}

/**
 * Creates a progress fingerprint for integration stage.
 */
export function createIntegrationFingerprint(
  integrationOutput: string,
  timestamp: string,
): ProgressFingerprint {
  return {
    stage: "integration",
    evidenceHash: createEvidenceHash(extractIntegrationEvidence(integrationOutput)),
    recordedAt: timestamp,
  };
}

/**
 * Creates a generic progress fingerprint for any stage.
 */
export function createFingerprint(
  stage: string,
  evidenceContent: string,
  timestamp: string,
): ProgressFingerprint {
  return {
    stage,
    evidenceHash: createEvidenceHash(evidenceContent),
    recordedAt: timestamp,
  };
}

/**
 * Creates a no-progress fingerprint when no meaningful output is generated.
 */
export function createNoProgressFingerprint(
  stage: string,
  timestamp: string,
): ProgressFingerprint {
  return {
    stage,
    evidenceHash: "no_progress",
    recordedAt: timestamp,
  };
}
