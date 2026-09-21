/**
 * прогресс fingerprinting - extracts evidence конкретного этапа для обнаружением циклов.
 */

import { createHash } from "node:crypto";
import type { ProgressFingerprint } from "./recovery-types.js";

/**
 * Generates Объект hash из evidence content.
 */
export function createEvidenceHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Извлекает evidence из review результат для fingerprinting.
 */
export function extractReviewEvidence(reviewOutput: string): string {
  // Normalize и extract key findings
  return reviewOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Извлекает evidence из QОбъект результат для fingerprinting.
 */
export function extractQAEvidence(qaOutput: string): string {
  // Normalize и extract key findings
  return qaOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * Извлекает evidence из integration результат для fingerprinting.
 */
export function extractIntegrationEvidence(integrationOutput: string): string {
  // Normalize и extract key findings
  return integrationOutput
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/**
 * создаёт Объект прогресс fingerprint для review этап.
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
 * создаёт Объект прогресс fingerprint для QОбъект этап.
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
 * создаёт Объект прогресс fingerprint для integration этап.
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
 * создаёт Объект generic прогресс fingerprint для любой этап.
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
 * создаёт Объект no-progress fingerprint когда no содержательный результат является generated.
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
