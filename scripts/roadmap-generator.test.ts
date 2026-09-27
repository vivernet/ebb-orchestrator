import { describe, it, expect } from 'vitest';
import { generateRoadmap, renderPlanRegister, renderDependencyGraph, type PlanMetadata } from './roadmap-generator.js';

describe('roadmap-generator', () => {
  const mockPlans: PlanMetadata[] = [
    {
      id: 'plan-01',
      kind: 'plan',
      status: 'completed',
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
      status: 'planned',
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
      expect(result).toContain('## Plan Register');
      expect(result).toContain('## Dependency Graph');
      expect(result).not.toMatch(/stage/i);
    });

    it('should handle empty plans array', () => {
      const result = generateRoadmap([]);
      expect(result).toContain('# Автоматический роадмап');
    });

    it('excludes non-Plan records from every roadmap projection', () => {
      const ledger = {
        id: 'ledger-01',
        kind: 'ledger',
        status: 'draft',
        title: 'Ledger Fixture',
        created: '2026-09-20',
        updated: '2026-09-21',
        depends_on: ['plan-01'],
      } as unknown as PlanMetadata;
      const mixedRecords = [...mockPlans, ledger];

      expect(generateRoadmap(mixedRecords)).not.toContain('ledger-01');
      expect(renderPlanRegister(mixedRecords)).not.toContain('Ledger Fixture');
      expect(renderDependencyGraph(mixedRecords)).not.toContain('ledger-01');
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

    it('preserves every PlanStatus in the register', () => {
      const statuses: PlanMetadata['status'][] = ['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled'];
      const plans = statuses.map((status, index) => ({
        ...mockPlans[0],
        id: `plan-${String(index + 1).padStart(2, '0')}`,
        status,
      }));
      const result = renderPlanRegister(plans);

      for (const plan of plans) expect(result).toContain(`| ${plan.id} | ${plan.status} |`);
      expect(result).not.toMatch(/stage/i);
    });
  });

  describe('renderDependencyGraph', () => {
    it('should render dependency graph with dependencies', () => {
      const result = renderDependencyGraph(mockPlans);
      expect(result).toContain('plan-01 → plan-02');
      expect(result).toContain('plan-02 → plan-03');
    });

    it('should render plans with no dependencies', () => {
      const noDepsPlans: PlanMetadata[] = [
        {
          id: 'plan-01',
          kind: 'plan',
          status: 'completed',
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
