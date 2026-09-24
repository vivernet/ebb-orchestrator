import { describe, it, expect } from 'vitest';
import { generateRoadmap, renderStageRegister, renderPlanRegister, renderDependencyGraph, type PlanMetadata } from './roadmap-generator.js';

describe('roadmap-generator', () => {
  const mockPlans: PlanMetadata[] = [
    {
      id: 'plan-01',
      kind: 'plan',
      roadmap: '01',
      stage: '02',
      status: 'done',
      title: 'Initial Setup',
      created: '2026-09-01',
      updated: '2026-09-10',
      depends_on: [],
      specs: [],
      evidence: [],
    },
    {
      id: 'plan-02',
      kind: 'plan',
      roadmap: '01',
      stage: '03',
      status: 'in-progress',
      title: 'Core Implementation',
      created: '2026-09-05',
      updated: '2026-09-20',
      depends_on: ['plan-01'],
      specs: [],
      evidence: [],
    },
    {
      id: 'plan-03',
      kind: 'plan',
      roadmap: '01',
      stage: '04',
      status: 'proposed',
      title: 'Testing & QA',
      created: '2026-09-15',
      updated: '2026-09-20',
      depends_on: ['plan-02'],
      specs: [],
      evidence: [],
    },
  ];

  describe('generateRoadmap', () => {
    it('should generate a complete roadmap document', () => {
      const result = generateRoadmap(mockPlans);
      expect(result).toContain('# Автоматический роадмап');
      expect(result).toContain('## Stage Register');
      expect(result).toContain('## Plan Register');
      expect(result).toContain('## Dependency Graph');
    });

    it('should handle empty plans array', () => {
      const result = generateRoadmap([]);
      expect(result).toContain('# Автоматический роадмап');
    });
  });

  describe('renderStageRegister', () => {
    it('should render stage register with stages', () => {
      const stages = [
        { id: '02', plans: [mockPlans[0]], done: 1, total: 1 },
        { id: '03', plans: [mockPlans[1]], done: 0, total: 1 },
        { id: '04', plans: [mockPlans[2]], done: 0, total: 1 },
      ];
      const result = renderStageRegister(stages);
      expect(result).toContain('| Stage |');
      expect(result).toContain('|-------|');
    });
  });

  describe('renderPlanRegister', () => {
    it('should render plan register with all plans', () => {
      const result = renderPlanRegister(mockPlans);
      expect(result).toContain('| ID |');
      expect(result).toContain('|----|');
      expect(result).toContain('plan-01');
      expect(result).toContain('plan-02');
    });
  });

  describe('renderDependencyGraph', () => {
    it('should render dependency graph with dependencies', () => {
      const result = renderDependencyGraph(mockPlans);
      expect(result).toContain('plan-02 → plan-01');
    });

    it('should render plans with no dependencies', () => {
      const noDepsPlans: PlanMetadata[] = [
        {
          id: 'plan-01',
          kind: 'plan',
          roadmap: '01',
          stage: '02',
          status: 'done',
          title: 'Test',
          created: '2026-09-01',
          updated: '2026-09-01',
          depends_on: [],
          specs: [],
          evidence: [],
        },
      ];
      const result = renderDependencyGraph(noDepsPlans);
      expect(result).toContain('No dependencies');
    });
  });
});
