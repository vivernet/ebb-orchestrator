import { describe, it, expect } from 'vitest';
import { generateRoadmap } from './roadmap-generator.js';
import { collectPlans } from './plan-collector.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createPlansDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'roadmap-generator-integration-'));
}

function writePlan(directory: string, id: string, status: string, dependsOn: string[] = []): void {
  const metadata = {
    id,
    kind: 'plan',
    status,
    title: `${id} fixture`,
    created: '2026-09-26',
    updated: '2026-09-27',
    depends_on: dependsOn,
  };
  const frontmatter = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : JSON.stringify(value)}`)
    .join('\n');
  writeFileSync(join(directory, `${id}.md`), `---\n${frontmatter}\n---\n`);
}

describe('roadmap-generator integration', () => {
  it('генерирует Plan-only roadmap из изолированной коллекции', () => {
    const directory = createPlansDirectory();
    try {
      writePlan(directory, 'plan-91', 'planned');
      writePlan(directory, 'plan-92', 'completed', ['plan-91']);
      const plans = collectPlans(directory);
      const result = generateRoadmap(plans);

      expect(plans.map((plan) => plan.id)).toEqual(['plan-91', 'plan-92']);
      expect(result).toContain('# Автоматический роадмап');
      expect(result).toContain('## Plan Register');
      expect(result).toContain('## Dependency Graph');
      expect(result).toContain('plan-91 → plan-92');
      expect(result).not.toMatch(/stage|grouping/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('должен правильно обрабатывать пустой список планов', () => {
    const result = generateRoadmap([]);

    expect(result).toContain('# Автоматический роадмап');
    expect(result).toContain('Нет доступных планов');
    expect(result).not.toMatch(/stage|grouping/i);
  });

  it('должен обновлять роадмап при добавлении нового плана', () => {
    const directory = createPlansDirectory();
    try {
      expect(generateRoadmap(collectPlans(directory))).toContain('Нет доступных планов');
      writePlan(directory, 'plan-93', 'proposed');
      const [newPlan] = collectPlans(directory);
      const withPlan = generateRoadmap([newPlan]);

      expect(withPlan).toContain(newPlan.id);
      expect(withPlan).toContain(newPlan.title);
      expect(withPlan).not.toContain('Нет доступных планов');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('должен валидировать зависимости между планами', () => {
    const directory = createPlansDirectory();
    try {
      writePlan(directory, 'plan-90', 'completed');
      writePlan(directory, 'plan-91', 'planned', ['plan-90']);
      const plans = collectPlans(directory);
      const result = generateRoadmap(plans);

      expect(result).toContain('## Dependency Graph');
      expect(result).toContain('plan-90 → plan-91');
      expect(result).not.toContain('plan-91 → plan-90');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
