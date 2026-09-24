import { describe, it, expect } from 'vitest';
import { parsePlan } from './plan-parser';

describe('plan-parser', () => {
  it('должен парсить YAML frontmatter из плана', () => {
    const path = 'docs/architecture/plans/13-roadmap-generator.md';
    const metadata = parsePlan(path);
    
    expect(metadata.id).toBe('plan-13');
    expect(metadata.kind).toBe('plan');
    expect(String(metadata.roadmap)).toBe('1');
    expect(String(metadata.stage)).toBe('9');
    expect(metadata.status).toBe('proposed');
    expect(metadata.title).toBe('Автоматическая генерация роадмапа');
    expect(metadata.created).toBe('2026-09-23');
    expect(metadata.updated).toBe('2026-09-23');
    expect(metadata.depends_on).toEqual(['plan-09']);
    expect(metadata.specs).toEqual(['../specs/01-system-design.md']);
    expect(metadata.evidence).toEqual([]);
  });

  it('должен выбрасывать ошибку для несуществующего файла', () => {
    expect(() => parsePlan('nonexistent.md')).toThrow();
  });

  it('должен обрабатывать файлы без valid frontmatter', () => {
    const path = 'scripts/plan-parser.ts';
    expect(() => parsePlan(path)).toThrow();
  });
});
