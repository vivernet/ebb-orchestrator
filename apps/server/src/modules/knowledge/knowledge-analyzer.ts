/**
 * Knowledge Analyzer – deterministic candidate narrowing и classification
 * для knowledge change proposals.
 *
 * Двухэтапный подход:
 *   1. Deterministic candidate narrowing by category/scope/path/tags/normalized text
 *   2. AI semantic comparison only on the small candidate set (not done here)
 *
 * Классификация:
 *   новый         — no overlapping candidate
 *   DUPLICATE   — точный normalized duplicate
 *   EDITORIAL — изменение только форматирования и пробелов
 *   CLARIFICATION — тот же topic, more конкретного
 *   EXTENSION — расширяет существующую guideline
 *   CONFLICT — противоречит существующей guideline
 *   REPLACEMENT — заменяет существующую guideline
 */

import { parseGuideline } from "./guideline-parser.js";
import type { GuidelineRecord } from "./knowledge-types.js";

// ── Types ───────────────────────────────────────────────────────────

export type ProposalClassification =
  | "NEW"
  | "DUPLICATE"
  | "EDITORIAL"
  | "CLARIFICATION"
  | "EXTENSION"
  | "CONFLICT"
  | "REPLACEMENT";

export interface AnalysisResult {
  /** Deterministic classification (DUPLICATE, EDITORIAL, новый являются deterministic; others require AI). */
  classification: ProposalClassification;
  /** Narrowed candidate set Объект proposal was compared against. */
  candidates: GuidelineRecord[];
  /** Whether Объект AI semantic analysis run является needed. */
  requiresAiAnalysis: boolean;
  /** Если DUPLICATE or EDITORIAL, the matched candidate's DB id. */
  matchedCandidateId: string | null;
  /** Если applicable, the reason for the classification. */
  reason: string | null;
}

export interface ProposalInput {
  projectId: string;
  markdown: string;
}

// ── Normalization ───────────────────────────────────────────────────

/**
 * Normalize text для comparison: lowercase, collapse whitespace,
 * Удаляет пунктуацию и обрезает пробелы.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-.]/g, " ")           // punctuation → space
    .replace(/\s+/g, " ")              // collapse whitespace
    .trim();
}

/**
 * Проверяет if the difference between two normalized texts is only
 * whitespace / formatting (i.e. Объект normalized forms являются identical).
 */
function isEditorialOnly(original: string, proposed: string): boolean {
  return normalizeText(original) === normalizeText(proposed);
}

// ── Scope overlap ───────────────────────────────────────────────────

/**
 * Determine если два область strings overlap.
 * "project" scope is considered to overlap with everything.
 * "area" scope overlaps with "area" and "project".
 * "path" scope overlaps with "path", "area", and "project".
 */
function scopesOverlap(scopeA: string, scopeB: string): boolean {
  const a = scopeA.toLowerCase();
  const b = scopeB.toLowerCase();
  if (a === b) return true;
  // проект является Объект superset
  if (a === "project" || b === "project") return true;
  // являютсяОбъект содержит путь
  if ((a === "area" && b === "path") || (a === "path" && b === "area")) return true;
  return false;
}

// ── Content keyword extraction for heuristic classification ──────────

/**
 * Извлекает significant words from text for heuristic overlap detection.
 * Фильтрует common stop words.
 */
function extractSignificantWords(text: string): Set<string> {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "because", "but", "and", "or",
    "if", "while", "about", "up", "it", "its", "that", "this", "these",
    "those", "also", "must", "use", "using", "used", "e.g",
  ]);

  const words = normalizeText(text)
    .split(" ")
    .filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(words);
}

/**
 * Compute Jaccard similarity between два word sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Detect если Объект proposal negates или contradicts Объект candidate content.
 * Looks для negation patterns (e.g. "должен не", "не должен", "не")
 * where Объект candidate makes Объект affirmative statement.
 */
function hasContradiction(candidateContent: string, proposalContent: string): boolean {
  const negationPatterns = [
    /\bshould not\b/i,
    /\bmust not\b/i,
    /\bdo not\b/i,
    /\bdoes not\b/i,
    /\bdid not\b/i,
    /\bwill not\b/i,
    /\bwould not\b/i,
    /\bcannot\b/i,
    /\bnever\b/i,
    /\bavoid\b/i,
    /\bnot use\b/i,
    /\bnot\b.*\binstead\b/i,
  ];

  const proposalLower = proposalContent.toLowerCase();

  // Проверяет if proposal contains negation patterns
  const hasNegation = negationPatterns.some((p) => p.test(proposalLower));
  if (!hasNegation) return false;

  // Извлекает key content words from candidate (excluding stop words)
  const candidateWords = extractSignificantWords(candidateContent);

  // Проверяет if the proposal also mentions the same key concepts
  // (meaning it's talking about the same thing but negating it)
  const proposalWords = extractSignificantWords(proposalContent);
  const overlap = jaccardSimilarity(candidateWords, proposalWords);

  // Если there's significant word overlap AND negation, it's a contradiction
  return overlap > 0.3;
}

// ── Main Analyzer ───────────────────────────────────────────────────

/**
 * Предоставляет публичный контракт модуля knowledge-analyzer для взаимодействия слоёв приложения.
 */
export class KnowledgeAnalyzer {
  /**
   * Classify Объект proposal against Объект existing guideline записи.
   *
   * Этот analyzer performs deterministic narrowing first, then heuristic
   * classification. фактический semantic AI comparison является flagged via
   * `requiresAiAnalysis` and left to the orchestrator.
   */
  classify(proposal: ProposalInput, existingCandidates: GuidelineRecord[]): AnalysisResult {
    // разбирать Объект proposal markdown to extract metadata
    const parsed = parseGuideline(proposal.markdown);
    const proposalContent = parsed.content;

    // этап 1: Deterministic candidate narrowing
    const narrowed = this.narrowCandidates(parsed, existingCandidates);

    if (narrowed.length === 0) {
      return {
        classification: "NEW",
        candidates: [],
        requiresAiAnalysis: false,
        matchedCandidateId: null,
        reason: "No overlapping candidates found in category and scope.",
      };
    }

    // этап 2: Deterministic checks on narrowed candidates

    // ── Deterministic: hash match → DUPLICATE ──────────────────────
    // Identical content hash means Объект content является Объект тот же regardless of display ID.
    for (const candidate of narrowed) {
      if (candidate.contentHash === parsed.contentHash) {
        return {
          classification: "DUPLICATE",
          candidates: narrowed,
          requiresAiAnalysis: false,
          matchedCandidateId: candidate.id,
          reason: "Content hash matches exactly — identical content.",
        };
      }
    }

    // ── Deterministic: editorial (whitespace/formatting only) ──────
    // Проверяет same-guideline-ID candidates first (most likely editorial)
    for (const candidate of narrowed) {
      if (candidate.displayId === parsed.id && isEditorialOnly(candidate.content, proposalContent)) {
        return {
          classification: "EDITORIAL",
          candidates: narrowed,
          requiresAiAnalysis: false,
          matchedCandidateId: candidate.id,
          reason: "Only whitespace/formatting differences detected.",
        };
      }
    }
    // Также check across all candidates for exact normalized duplicate
    for (const candidate of narrowed) {
      if (candidate.displayId !== parsed.id && isEditorialOnly(candidate.content, proposalContent)) {
        return {
          classification: "DUPLICATE",
          candidates: narrowed,
          requiresAiAnalysis: false,
          matchedCandidateId: candidate.id,
          reason: "Normalized content is identical to an existing guideline.",
        };
      }
    }

    // ── Heuristic: contradiction detection → CONFLICT ──────────────
    // Если the proposal negates statements from a same-ID candidate, it's CONFLICT.
    for (const candidate of narrowed) {
      if (candidate.displayId === parsed.id) {
        if (hasContradiction(candidate.content, proposalContent)) {
          return {
            classification: "CONFLICT",
            candidates: narrowed,
            requiresAiAnalysis: true,
            matchedCandidateId: candidate.id,
            reason: "Proposal contains negation patterns contradicting the existing guideline. Requires AI analysis.",
          };
        }
      }
    }

    // ── Heuristic: similarity-based classification ─────────────────
    const proposalWords = extractSignificantWords(proposalContent);
    let bestSameIdCandidate: GuidelineRecord | null = null;
    let bestSameIdSimilarity = 0;

    for (const candidate of narrowed) {
      if (candidate.displayId === parsed.id) {
        const candidateWords = extractSignificantWords(candidate.content);
        const similarity = jaccardSimilarity(proposalWords, candidateWords);
        if (similarity > bestSameIdSimilarity) {
          bestSameIdSimilarity = similarity;
          bestSameIdCandidate = candidate;
        }
      }
    }

    // тот же display ID, разный content → версия change
    if (bestSameIdCandidate && bestSameIdCandidate.displayId === parsed.id) {
      if (bestSameIdSimilarity > 0.4) {
        return {
          classification: "EXTENSION",
          candidates: narrowed,
          requiresAiAnalysis: true,
          matchedCandidateId: bestSameIdCandidate.id,
          reason: "Significant content overlap with same guideline ID — likely extension. Requires AI analysis.",
        };
      }
      return {
        classification: "REPLACEMENT",
        candidates: narrowed,
        requiresAiAnalysis: true,
        matchedCandidateId: bestSameIdCandidate.id,
        reason: "Low overlap with same guideline ID — likely replacement. Requires AI analysis.",
      };
    }

    // Нет same-ID candidate — check cross-guideline overlap
    let crossCandidate: GuidelineRecord | null = null;
    let crossSimilarity = 0;
    for (const candidate of narrowed) {
      const candidateWords = extractSignificantWords(candidate.content);
      const similarity = jaccardSimilarity(proposalWords, candidateWords);
      if (similarity > crossSimilarity) {
        crossSimilarity = similarity;
        crossCandidate = candidate;
      }
    }

    if (crossCandidate && crossSimilarity > 0.5) {
      return {
        classification: "CLARIFICATION",
        candidates: narrowed,
        requiresAiAnalysis: true,
        matchedCandidateId: crossCandidate.id,
        reason: "Significant content overlap with different guideline — likely clarification. Requires AI analysis.",
      };
    }

    // Нет strong overlap → NEW
    return {
      classification: "NEW",
      candidates: narrowed,
      requiresAiAnalysis: false,
      matchedCandidateId: null,
      reason: "No significant content overlap with any candidate.",
    };
  }

  /**
   * Narrow Объект full candidate set to только те который overlap in
   * category и область с Объект proposed guideline.
   */
  private narrowCandidates(
    parsed: { id: string; category: string; scope: string },
    existing: GuidelineRecord[],
  ): GuidelineRecord[] {
    return existing.filter((candidate) => {
      // тот же category
      if (candidate.category !== parsed.category) return false;
      // Overlapping область
      if (!scopesOverlap(candidate.scope, parsed.scope)) return false;
      // Только active guidelines are candidates
      if (candidate.status !== "ACTIVE") return false;
      return true;
    });
  }
}
