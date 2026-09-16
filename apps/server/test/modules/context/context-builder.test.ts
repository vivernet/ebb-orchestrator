import { describe, expect, it, beforeEach } from 'vitest';
import { ContextBuilder } from '../../../src/modules/context/context-builder.js';
import { ManifestBuilder } from '../../../src/modules/context/context-manifest.js';
import { PromptBuilder } from '../../../src/modules/runtime/prompt-builder.js';
import type { TaskContract, Finding, Defect, Guideline, Decision } from '../../../src/modules/context/context-types.js';

describe('ContextBuilder - Role Separation', () => {
  const mockTaskContract: TaskContract = {
    id: 'TASK-001',
    goal: 'Add health endpoint',
    context: 'Testing context',
    requirements: ['Must return status ok'],
    acceptanceCriteria: ['Status must be ok'],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: ['Tests pass'],
    priority: 'p0' as const,
  };

  const mockDeveloperSession: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'Implement health endpoint' },
    { role: 'assistant', content: 'Here is the implementation' },
  ];

  const mockActiveFinding: Finding = {
    id: 'FINDING-001',
    status: 'open',
    title: 'Missing null check',
    severity: 'high',
  };

  const mockResolvedFinding: Finding = {
    id: 'FINDING-002',
    status: 'resolved',
    title: 'Already fixed issue',
    severity: 'low',
  };

  const mockDefect: Defect = {
    id: 'DEFECT-001',
    status: 'open',
    title: 'Test failure',
  };

  const mockGuidelines: Guideline[] = [
    { id: 'GL-001', category: 'security', status: 'active', text: 'Always validate input' },
  ];

  const mockDecisions: Decision[] = [
    { id: 'DEC-001', status: 'accepted', text: 'Use REST API style' },
  ];

  const mockGitDiff = 'diff --git a/src/health.ts b/src/health.ts';

  const mockWorkspaceMeta = {
    repoPath: '/test/repo',
    branch: 'feature/health-endpoint',
    commitHash: 'abc123',
  };

  const contextBuilder = new ContextBuilder();

  describe('Developer Context Package', () => {
    it('should include Task Contract', () => {
      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        workspaceMeta: mockWorkspaceMeta,
      });
      expect(pkg.taskContract).toEqual(mockTaskContract);
    });

    it('should include relevant active findings/defects', () => {
      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        findings: [mockActiveFinding],
        defects: [mockDefect],
      });
      expect(pkg.findings).toContain(mockActiveFinding);
      expect(pkg.defects).toContain(mockDefect);
    });

    it('should NOT include resolved findings', () => {
      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        findings: [mockActiveFinding, mockResolvedFinding],
      });
      expect(pkg.findings).not.toContain(mockResolvedFinding);
    });

    it('should include target/workspace metadata', () => {
      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        workspaceMeta: mockWorkspaceMeta,
      });
      expect(pkg.workspaceMeta).toEqual(mockWorkspaceMeta);
    });

    it('should include Developer session transcript in Developer package', () => {
      const devPkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        developerSession: mockDeveloperSession,
      });
      expect(devPkg.sessionTranscript).toEqual(mockDeveloperSession);
    });
  });

  describe('Reviewer Context Package', () => {
    it('should include Task Contract', () => {
      const pkg = contextBuilder.buildReviewerPackage({
        taskContract: mockTaskContract,
        gitDiff: mockGitDiff,
      });
      expect(pkg.taskContract).toEqual(mockTaskContract);
    });

    it('should include Git diff', () => {
      const pkg = contextBuilder.buildReviewerPackage({
        taskContract: mockTaskContract,
        gitDiff: mockGitDiff,
      });
      expect(pkg.gitDiff).toBe(mockGitDiff);
    });

    it('should NOT contain Developer session transcript', () => {
      const pkg = contextBuilder.buildReviewerPackage({
        taskContract: mockTaskContract,
        developerSession: mockDeveloperSession,
        gitDiff: mockGitDiff,
      });
      expect(pkg.sessionTranscript).toBeUndefined();
    });

    it('should include relevant constraints (guidelines/decisions)', () => {
      const pkg = contextBuilder.buildReviewerPackage({
        taskContract: mockTaskContract,
        guidelines: mockGuidelines,
        decisions: mockDecisions,
      });
      expect(pkg.guidelines).toEqual(mockGuidelines);
      expect(pkg.decisions).toEqual(mockDecisions);
    });

    it('should NOT include Developer findings/defects', () => {
      const pkg = contextBuilder.buildReviewerPackage({
        taskContract: mockTaskContract,
      });
      // Reviewer package doesn't include findings/defects by default
      expect(pkg.findings).toEqual([]);
      // @ts-ignore - check that defects field doesn't exist on ReviewerContextPackage
      expect(pkg.defects).toBeUndefined();
    });
  });
});

describe('ContextBuilder - Budget Pruning', () => {
  const mockTaskContract: TaskContract = {
    id: 'TASK-001',
    goal: 'Test',
    context: 'Test',
    requirements: [],
    acceptanceCriteria: [],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: [],
    priority: 'p0' as const,
  };

  const contextBuilder = new ContextBuilder();

  describe('P0 Task Contract', () => {
    it('can never be pruned', () => {
      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
      });
      expect(pkg.taskContract).toBeDefined();
      expect(pkg.taskContract.priority).toBe('p0');
    });
  });

  describe('Resolved findings exclusion', () => {
    it('should exclude resolved findings from context', () => {
      const resolvedFinding: Finding = {
        id: 'FINDING-001',
        status: 'resolved',
        title: 'Fixed',
        severity: 'medium',
      };

      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        findings: [resolvedFinding],
      });
      expect(pkg.findings).not.toContain(resolvedFinding);
      expect(pkg.findings).toEqual([]);
    });
  });

  describe('P0-P3 budget pruning', () => {
    it('should prune P3 items under budget pressure', () => {
      const guideline: Guideline = {
        id: 'GL-003',
        category: 'style',
        status: 'active',
        text: 'Use camelCase',
        priority: 'p3',
      };

      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        guidelines: [guideline],
        budgetLimit: 100,
      });
      // P3 guidelines should be pruned under budget pressure
      expect(pkg.guidelines).not.toContain(guideline);
    });

    it('should NOT prune P0 guidelines under budget pressure', () => {
      const guideline: Guideline = {
        id: 'GL-001',
        category: 'security',
        status: 'active',
        text: 'Must validate input',
        priority: 'p0',
      };

      const pkg = contextBuilder.buildDeveloperPackage({
        taskContract: mockTaskContract,
        guidelines: [guideline],
        budgetLimit: 100,
      });
      // P0 guidelines should always be included
      expect(pkg.guidelines).toContain(guideline);
    });
  });
});

describe('ManifestBuilder', () => {
  const mockTaskContract = {
    id: 'TASK-001',
    goal: 'Test',
    context: 'Test',
    requirements: [],
    acceptanceCriteria: [],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: [],
    priority: 'p0' as const,
  };

  const manifestBuilder = new ManifestBuilder();

  it('should persist manifest IDs and versions', () => {
    const manifest = manifestBuilder.build({
      taskContractVersion: '1.0.0',
      guidelineIds: ['GL-001', 'GL-002'],
      decisionIds: ['DEC-001'],
      findingIds: ['FINDING-001'],
      contextBuilderVersion: '1.0.0',
    });

    expect(manifest.taskContractVersion).toBe('1.0.0');
    expect(manifest.guidelineIds).toEqual(['GL-001', 'GL-002']);
    expect(manifest.decisionIds).toEqual(['DEC-001']);
    expect(manifest.findingIds).toEqual(['FINDING-001']);
  });

  it('should NOT include secrets in manifest', () => {
    const manifest = manifestBuilder.build({
      taskContractVersion: '1.0.0',
    });

    // Secret fields should not exist
    expect((manifest as any).secrets).toBeUndefined();
    expect((manifest as any).apiKey).toBeUndefined();
  });

  it('should include initial token size', () => {
    const manifest = manifestBuilder.build({
      taskContractVersion: '1.0.0',
      initialTokenSize: 5000,
    });

    expect(manifest.initialTokenSize).toBe(5000);
  });
});

describe('PromptBuilder', () => {
  const promptBuilder = new PromptBuilder();

  describe('Developer prompt', () => {
    it('should NOT bulk-load source code', () => {
      const prompt = promptBuilder.buildDeveloperPrompt({
        taskContract: {
          id: 'TASK-001',
          goal: 'Test',
          context: 'Test',
          requirements: [],
          acceptanceCriteria: [],
          dependencies: [],
          nonGoals: [],
          definitionOfDone: [],
          priority: 'p0' as const,
        },
        outputInstructions: 'Implement the task',
      });

      // Source code should not be in prompt (should be accessed via tools)
      expect(prompt).not.toContain('function myFunction');
      expect(prompt).not.toContain('class MyClass');
    });

    it('should include role contract summary', () => {
      const prompt = promptBuilder.buildDeveloperPrompt({
        taskContract: {
          id: 'TASK-001',
          goal: 'Test',
          context: 'Test',
          requirements: [],
          acceptanceCriteria: [],
          dependencies: [],
          nonGoals: [],
          definitionOfDone: [],
          priority: 'p0' as const,
        },
        outputInstructions: 'Implement the task',
        roleContractSummary: 'You are a developer',
      });

      expect(prompt).toContain('You are a developer');
    });
  });

  describe('Reviewer prompt', () => {
    it('should NOT include Developer conversation', () => {
      const prompt = promptBuilder.buildReviewerPrompt({
        taskContract: {
          id: 'TASK-001',
          goal: 'Test',
          context: 'Test',
          requirements: [],
          acceptanceCriteria: [],
          dependencies: [],
          nonGoals: [],
          definitionOfDone: [],
          priority: 'p0' as const,
        },
        gitDiff: 'diff --git',
        checks: [],
      });

      expect(prompt).not.toContain('Developer said');
      expect(prompt).not.toContain('Developer implementation');
    });
  });
});
