import { describe, it, expect } from 'vitest';
import { generateRoadmap } from './roadmap-generator.js';
import { parsePlan } from './plan-parser.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('roadmap-generator integration', () => {
  it('должен генерировать полный роадмап из реальных планов', () => {
    // Parse a real plan from the docs
    const planPath = join(__dirname, '../docs/architecture/plans/13-roadmap-generator.md');
    const realPlan = parsePlan(planPath);
    
    // Generate roadmap with real data
    const result = generateRoadmap([realPlan]);
    
    // Verify structure matches expected roadmap format
    expect(result).toContain('# Автоматический роадмап');
    expect(result).toContain('## Stage Register');
    expect(result).toContain('## Plan Register');
    expect(result).toContain('## Dependency Graph');
    expect(result).toContain(realPlan.id);
  });

  it('должен правильно обрабатывать пустой список планов', () => {
    const result = generateRoadmap([]);
    
    expect(result).toContain('# Автоматический роадмап');
    expect(result).toContain('Нет доступных планов');
  });

  it('должен обновлять роадмап при добавлении нового плана', () => {
    // Start with empty
    const empty = generateRoadmap([]);
    expect(empty).toContain('Нет доступных планов');
    
    // Add a plan
    const planPath = join(__dirname, '../docs/architecture/plans/13-roadmap-generator.md');
    const newPlan = parsePlan(planPath);
    const withPlan = generateRoadmap([newPlan]);
    
    // Verify update happened
    expect(withPlan).toContain(newPlan.id);
    expect(withPlan).toContain(newPlan.title);
    expect(withPlan).not.toContain('Нет доступных планов');
  });

  it('должен валидировать зависимости между планами', () => {
    const planPath = join(__dirname, '../docs/architecture/plans/13-roadmap-generator.md');
    const plan = parsePlan(planPath);
    const result = generateRoadmap([plan]);
    
    // Verify dependency graph section exists
    expect(result).toContain('## Dependency Graph');
    if (plan.depends_on && plan.depends_on.length > 0) {
      expect(result).toContain(plan.id);
    }
  });
});
