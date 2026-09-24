import { describe, it, expect } from 'vitest';
import { parsePlan } from './plan-parser.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('plan-parser integration', () => {
  it('должен корректно парсить реальный план из архитектуры', () => {
    const planPath = join(__dirname, '../docs/architecture/plans/13-roadmap-generator.md');
    const metadata = parsePlan(planPath);
    
    expect(metadata.id).toBe('plan-13');
    expect(metadata.kind).toBe('plan');
    expect(metadata.roadmap).toBe(1);
    expect(metadata.stage).toBe(9);
    expect(metadata.status).toBe('proposed');
    expect(metadata.title).toBe('Автоматическая генерация роадмапа');
    expect(metadata.depends_on).toEqual(['plan-09']);
  });

  it('должен выбрасывать ошибку для файла без YAML frontmatter', () => {
    const badPath = join(__dirname, 'plan-parser.ts');
    expect(() => parsePlan(badPath)).toThrow(/не содержит valid YAML frontmatter/);
  });
});
