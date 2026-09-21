/**
 * Парсер Markdown-решений — извлекает метаданные YAML front matter.
 * из `.md` files stored in Объект repository.
 */

import type { ParsedDecision, DecisionStatus, DecisionScope } from "./knowledge-types.js";

const VALID_STATUSES: readonly DecisionStatus[] = ["PROPOSED", "ACCEPTED", "SUPERSEDED", "OBSOLETE", "REJECTED"];
const VALID_SCOPES: readonly DecisionScope[] = ["PROJECT", "AREA", "EPIC", "TASK"];

const DEC_ID_RE = /^DEC-\d{4,}$/;

/**
 * разбирать YAML front matter из Объект decision Markdown файл.
 */
export function parseDecision(markdown: string): ParsedDecision {
  const fm = extractFrontMatter(markdown);
  const body = extractBody(markdown);

  const id = requireField(fm, "id");
  if (!DEC_ID_RE.test(id)) {
    throw new Error(`Invalid decision ID format: "${id}". Expected DEC-nnnn.`);
  }

  const status = requireEnumField(fm, "status", VALID_STATUSES);
  const scope = requireEnumField(fm, "scope", VALID_SCOPES);
  const title = requireField(fm, "title");
  const rationale = fm.rationale ?? "";
  const relatedGuideline = fm.related_guideline || null;

  return {
    id,
    status,
    scope,
    title,
    rationale,
    relatedGuideline,
    content: body,
  };
}

/**
 * Проверяет a parsed decision for consistency.
 */
export function validateDecision(parsed: ParsedDecision): void {
  if (parsed.relatedGuideline && !/^GL-[A-Z][A-Z0-9]*-\d{3,}$/.test(parsed.relatedGuideline)) {
    throw new Error(`Invalid related_guideline reference: "${parsed.relatedGuideline}".`);
  }
}

// ── helpers (same pattern as guideline-parser) ───────────────────────

function extractFrontMatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("Missing YAML front matter (expected --- delimited block at start of file).");
  }
  const fm: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    fm[key] = value;
  }
  return fm;
}

function extractBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1]!.trim() : markdown.trim();
}

function requireField(fm: Record<string, string>, key: string): string {
  const val = fm[key];
  if (val === undefined || val === "") {
    throw new Error(`Missing required front matter field: "${key}".`);
  }
  return val;
}

function requireEnumField<T extends string>(
  fm: Record<string, string>,
  key: string,
  valid: readonly T[],
): T {
  const raw = requireField(fm, key);
  if (!valid.includes(raw as T)) {
    throw new Error(`Invalid ${key}: "${raw}". Expected one of: ${valid.join(", ")}.`);
  }
  return raw as T;
}
