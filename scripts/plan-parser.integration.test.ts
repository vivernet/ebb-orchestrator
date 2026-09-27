import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { parsePlan } from './plan-parser.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('plan-parser integration', () => {
  it('должен корректно парсить изолированный Plan без группирующих полей', () => {
    const directory = mkdtempSync(join(tmpdir(), 'plan-parser-integration-'));
    const planPath = join(directory, 'plan.md');
    writeFileSync(planPath, `---
id: plan-91
kind: plan
status: completed
title: Fixture Plan
created: 2026-09-26
updated: 2026-09-27
depends_on:
  - plan-90
---

# Fixture Plan
`);

    try {
      const metadata = parsePlan(planPath);

      expect(metadata.id).toBe('plan-91');
      expect(metadata.kind).toBe('plan');
      expect(metadata.status).toBe('completed');
      expect(metadata).not.toHaveProperty('roadmap');
      expect(metadata).not.toHaveProperty('stage');
      expect(metadata.title).toBe('Fixture Plan');
      expect(metadata.depends_on).toEqual(['plan-90']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('должен выбрасывать ошибку для файла без YAML frontmatter', () => {
    const badPath = join(__dirname, 'plan-parser.ts');
    expect(() => parsePlan(badPath)).toThrow(/не содержит valid YAML frontmatter/);
  });
});
