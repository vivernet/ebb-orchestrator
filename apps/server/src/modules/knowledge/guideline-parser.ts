/**
 * Парсер Markdown-guideline — извлекает метаданные YAML front matter.
 * из `.md` files stored in Объект repository.
 *
 * Этот canonical text lives in the Markdown file; the DB stores
 * searchable metadata, версия, hash, и provenance.
 */

import { createHash } from "node:crypto";
import type { ParsedGuideline, GuidelinePriority, GuidelineStatus } from "./knowledge-types.js";

const VALID_PRIORITIES: readonly GuidelinePriority[] = ["REQUIRED", "RECOMMENDED", "PREFERENCE"];
const VALID_STATUSES: readonly GuidelineStatus[] = [
  "PROPOSED", "UNDER_REVIEW", "ACTIVE", "SUPERSEDED", "DEPRECATED", "REJECTED", "PENDING_EXTERNAL_CHANGE",
];

const GL_ID_RE = /^GL-[A-Z][A-Z0-9]*-\d{3,}$/;

/**
 * разбирать YAML front matter из Объект guideline Markdown файл.
 */
export function parseGuideline(markdown: string): ParsedGuideline {
  const fm = extractFrontMatter(markdown);
  const body = extractBody(markdown);

  const id = requireField(fm, "id");
  if (!GL_ID_RE.test(id)) {
    throw new Error(`Invalid guideline ID format: "${id}". Expected GL-<CATEGORY>-nnn.`);
  }

  const categoryMatch = id.match(/^GL-([A-Z][A-Z0-9]*)-/);
  const category = categoryMatch![1]!;

  const version = requireIntField(fm, "version");
  const priority = requireEnumField(fm, "priority", VALID_PRIORITIES);
  const status = requireEnumField(fm, "status", VALID_STATUSES);
  const scope = requireField(fm, "scope");
  const rationale = requireField(fm, "rationale");
  const provenance = fm.provenance ?? "";
  const contentHash = fm.content_hash ?? computeHash(body);
  const supersededBy = fm.superseded_by || null;

  const rolesRaw = fm.applicable_roles ?? "";
  const applicableRoles = rolesRaw
    ? rolesRaw.split(",").map((r: string) => r.trim()).filter(Boolean)
    : [];

  return {
    id,
    category,
    version,
    priority,
    status,
    scope,
    applicableRoles,
    rationale,
    provenance,
    contentHash,
    supersededBy,
    content: body,
  };
}

/**
 * Проверяет a parsed guideline for consistency.
 * Throws on некорректный состояние (e.g. broken superseded_by reference).
 */
export function validateGuideline(parsed: ParsedGuideline): void {
  if (parsed.supersededBy && !GL_ID_RE.test(parsed.supersededBy)) {
    throw new Error(`Invalid superseded_by reference: "${parsed.supersededBy}".`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

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

function requireIntField(fm: Record<string, string>, key: string): number {
  const raw = requireField(fm, key);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Field "${key}" must be a positive integer, got "${raw}".`);
  }
  return n;
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

function computeHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
