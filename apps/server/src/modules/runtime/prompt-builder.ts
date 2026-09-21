/**
 * Prompt Builder for Orchestrator Hermes.
 * Builds prompts for different agent roles.
 */

import type {
  TaskContract,
  Finding,
  Guideline,
  Decision,
} from '../context/context-types.js';

/**
 * Builds prompts for agent roles.
 */
export class PromptBuilder {
  private addTaskContract(lines: string[], contract: TaskContract): void {
    lines.push('=== TASK CONTRACT ===');
    lines.push(`Task ID: ${contract.id}`);
    lines.push(`Priority: ${contract.priority}`);
    lines.push(`Goal: ${contract.goal}`);
    lines.push(`Context: ${contract.context}`);
    lines.push(`Requirements: ${contract.requirements.join('; ') || 'none'}`);
    lines.push(`Acceptance Criteria: ${contract.acceptanceCriteria.join('; ') || 'none'}`);
    lines.push(`Dependencies: ${contract.dependencies.join('; ') || 'none'}`);
    lines.push(`Non-goals: ${contract.nonGoals.join('; ') || 'none'}`);
    lines.push(`Definition of Done: ${contract.definitionOfDone.join('; ') || 'none'}`);
    lines.push('');
  }

  private addSubmissionContract(lines: string[], role: string, instructions: string): void {
    lines.push('=== STRUCTURED RESULT / submit_result ===');
    lines.push(`Stage: ${role}`);
    lines.push(`Call submit_result exactly once using the validated ${role} schema.`);
    lines.push(instructions);
    lines.push('Do not treat free-form text as a result; report only facts observed in the assigned workspace.');
    lines.push('');
  }
  /**
   * Формирует Developer prompt.
   * Does NOT bulk-load source code (read on demand via tools).
   */
  buildDeveloperPrompt(input: {
    taskContract: TaskContract;
    outputInstructions?: string;
    roleContractSummary?: string;
    findings?: Finding[];
    guidelines?: Guideline[];
    decisions?: Decision[];
    workspaceMeta?: {
      repoPath?: string;
      branch?: string;
    };
  }): string {
    const lines: string[] = [];

    // Role contract summary (if provided)
    if (input.roleContractSummary) {
      lines.push(input.roleContractSummary);
      lines.push('');
    }

    this.addTaskContract(lines, input.taskContract);
    lines.push('=== ACCEPTANCE CRITERIA ===');
    lines.push('Every criterion is mandatory unless the contract explicitly says otherwise.');
    lines.push('');
    lines.push('=== NON-GOALS ===');
    lines.push('Do not change or reinterpret these boundaries.');
    lines.push('');

    // Source code instruction - do NOT bulk-load
    lines.push('=== SOURCE CODE ACCESS ===');
    lines.push('You can read source code files using workspace.read and workspace.search tools.');
    lines.push('Do not assume any file contents - read files on demand as needed.');
    lines.push('');

    // Workspace info
    if (input.workspaceMeta) {
      lines.push('=== WORKSPACE ===');
      if (input.workspaceMeta.repoPath) {
        lines.push(`Repository: ${input.workspaceMeta.repoPath}`);
      }
      if (input.workspaceMeta.branch) {
        lines.push(`Branch: ${input.workspaceMeta.branch}`);
      }
      lines.push('');
    }
    lines.push('=== STAGE ===');
    lines.push('DEVELOPMENT: implement the contract in the managed task worktree, verify it, and commit the change.');
    lines.push('');
    this.addSubmissionContract(lines, 'Developer', 'For COMPLETED, include the exact commitSha from git rev-parse HEAD in this managed worktree.');

    // Findings (relevant active ones)
    if (input.findings && input.findings.length > 0) {
      lines.push('=== ACTIVE FINDINGS ===');
      input.findings.forEach((f) => {
        lines.push(`- ${f.id}: ${f.title} (${f.severity})`);
      });
      lines.push('');
    }

    // Guidelines
    if (input.guidelines && input.guidelines.length > 0) {
      lines.push('=== GUIDELINES ===');
      input.guidelines.forEach((g) => {
        lines.push(`- [${g.id}] ${g.text}`);
      });
      lines.push('');
    }

    // Решения
    if (input.decisions && input.decisions.length > 0) {
      lines.push('=== DECISIONS ===');
      input.decisions.forEach((d) => {
        lines.push(`- [${d.id}] ${d.text}`);
      });
      lines.push('');
    }

    // Output instructions
    if (input.outputInstructions) {
      lines.push('=== OUTPUT INSTRUCTIONS ===');
      lines.push(input.outputInstructions);
      lines.push('');
    }

    lines.push('Begin your work.');

    return lines.join('\n');
  }

  /**
   * Формирует Reviewer prompt.
   * Does NOT include Developer conversation.
   */
  buildReviewerPrompt(input: {
    taskContract: TaskContract;
    gitDiff?: string;
    checks?: string[];
    guidelines?: Guideline[];
    decisions?: Decision[];
    findings?: Finding[];
  }): string {
    const lines: string[] = [];

    // Role identity
    lines.push('You are a Reviewer.');
    lines.push('Independently verify the implementation against the task contract.');
    lines.push('Do not rely on Developer reasoning or session history.');
    lines.push('');

    this.addTaskContract(lines, input.taskContract);
    lines.push('=== ACCEPTANCE CRITERIA ===');
    lines.push('Verify every required criterion independently; do not infer PASS from the diff alone.');
    lines.push('');
    lines.push('=== NON-GOALS ===');
    lines.push('Do not review or request unrelated changes.');
    lines.push('');

    // Git Diff
    if (input.gitDiff) {
      lines.push('=== CHANGES TO REVIEW ===');
      lines.push(input.gitDiff);
      lines.push('');
    }

    // Checks
    if (input.checks && input.checks.length > 0) {
      lines.push('=== AUTOMATED CHECKS ===');
      input.checks.forEach((check) => {
        lines.push(`- ${check}`);
      });
      lines.push('');
    }

    // Guidelines
    if (input.guidelines && input.guidelines.length > 0) {
      lines.push('=== GUIDELINES ===');
      input.guidelines.forEach((g) => {
        lines.push(`- [${g.id}] ${g.text}`);
      });
      lines.push('');
    }

    // Решения
    if (input.decisions && input.decisions.length > 0) {
      lines.push('=== DECISIONS ===');
      input.decisions.forEach((d) => {
        lines.push(`- [${d.id}] ${d.text}`);
      });
      lines.push('');
    }

    // Findings (for re-review)
    if (input.findings && input.findings.length > 0) {
      lines.push('=== PREVIOUS FINDINGS ===');
      input.findings.forEach((f) => {
        lines.push(`- ${f.id}: ${f.title} (${f.severity})`);
      });
      lines.push('');
    }

    // Output instructions
    lines.push('=== STAGE ===');
    lines.push('REVIEW: independently inspect the committed implementation and report concrete evidence.');
    lines.push('');
    lines.push('=== REVIEW PROCESS ===');
    lines.push('1. Read the task contract carefully');
    lines.push('2. Review the changes in the diff');
    lines.push('3. Check against requirements and acceptance criteria');
    lines.push('4. Verify against guidelines and decisions');
    lines.push('5. Report PASS only with findings (possibly an empty array), set independent=true, and include concrete file/test evidence');
    lines.push('6. Finish by calling submit_result exactly once with the validated Reviewer schema');
    lines.push('');
    this.addSubmissionContract(lines, 'Reviewer', 'For PASS, include independent=true, findings (possibly empty), and concrete file/test evidence.');
    lines.push('');

    lines.push('Begin your review.');

    return lines.join('\n');
  }

  /**
   * Формирует QA prompt.
   */
  buildQAPrompt(input: {
    taskContract: TaskContract;
    environment?: string;
    defects?: Finding[];  // Defects to retest
  }): string {
    const lines: string[] = [];

    lines.push('You are a QA Agent.');
    lines.push('Verify the implementation against acceptance criteria.');
    lines.push('Do not make implementation changes. Use the assigned workspace and report executable evidence.');
    lines.push('');

    this.addTaskContract(lines, input.taskContract);
    lines.push('=== ACCEPTANCE CRITERIA ===');
    input.taskContract.acceptanceCriteria.forEach((ac, index) => lines.push(`AC-${index + 1}: ${ac}`));
    lines.push('');
    lines.push('=== NON-GOALS ===');
    lines.push(input.taskContract.nonGoals.join('; ') || 'none');
    lines.push('');

    // Environment
    if (input.environment) {
      lines.push('=== ENVIRONMENT ===');
      lines.push(input.environment);
      lines.push('');
    }

    // Defects to retest
    if (input.defects && input.defects.length > 0) {
      lines.push('=== DEFECTS TO RETEST ===');
      input.defects.forEach((d) => {
        lines.push(`- ${d.id}: ${d.title}`);
      });
      lines.push('');
    }

    lines.push('=== STAGE ===');
    lines.push('QA: verify the implementation without modifying it and capture observed evidence for every required AC.');
    lines.push('');
    this.addSubmissionContract(lines, 'QA', 'For PASS, evidence must contain one non-empty entry for every AC-N, naming the criterion, command, and observed result.');

    // Output instructions
    lines.push('=== REVIEW PROCESS ===');
    lines.push('1. Execute acceptance criteria tests');
    lines.push('2. Verify behavior matches requirements');
    lines.push('3. Retest any reported defects');
    lines.push('4. Report PASS or list failed criteria');
    lines.push('');

    lines.push('Begin your QA verification.');

    return lines.join('\n');
  }

  /** Формирует the independent Integration prompt. */
  buildIntegrationPrompt(input: {
    taskContract: TaskContract;
    workspace?: string;
    targetRef?: string;
    checks?: string[];
    expectedTargetSha?: string;
    sourceSha?: string;
    integrationAttemptId?: string;
    provenanceDatabasePath?: string;
  }): string {
    const lines: string[] = [
      'You are an Integration Agent in an independent workspace.',
      'Do not implement new features. Verify provenance from the target base, merge/test the task branch, and report the exact base SHA.',
      '=== TASK CONTRACT ===',
      `Task ID: ${input.taskContract.id}`,
      `Priority: ${input.taskContract.priority}`,
      `Goal: ${input.taskContract.goal}`,
      `Context: ${input.taskContract.context}`,
      `Requirements: ${input.taskContract.requirements.join('; ') || 'none'}`,
      '=== ACCEPTANCE CRITERIA ===',
      ...input.taskContract.acceptanceCriteria.map((ac, index) => `AC-${index + 1}: ${ac}`),
      `Dependencies: ${input.taskContract.dependencies.join('; ') || 'none'}`,
      '=== NON-GOALS ===',
      input.taskContract.nonGoals.join('; ') || 'none',
      `Definition of Done: ${input.taskContract.definitionOfDone.join('; ') || 'none'}`,
      '=== STAGE ===',
      'INTEGRATION: verify the isolated merge, tests, and durable provenance; do not alter target or task worktrees.',
      '=== WORKSPACE ===',
      `Workspace: ${input.workspace ?? 'assigned workspace'}`,
      `Target ref: ${input.targetRef ?? 'master'}`,
      `Checks: ${(input.checks ?? []).join('; ') || 'run the project tests'}`,
      `Expected target SHA: ${input.expectedTargetSha ?? 'read from the persisted integration attempt'}`,
      `Expected source SHA: ${input.sourceSha ?? 'read from the persisted integration attempt'}`,
      `Integration attempt ID: ${input.integrationAttemptId ?? 'read from the persisted integration attempt'}`,
      `Provenance database: ${input.provenanceDatabasePath ?? 'authoritative persisted provenance database'}`,
      'A PASS must include baseSha equal to expected target SHA, sourceSha equal to expected source SHA, and provenance entries that identify this exact persisted integration attempt and its verification.',
      '=== STRUCTURED RESULT / submit_result ===',
      'Call submit_result exactly once using the validated Integration schema. Include outcome, baseSha, sourceSha, provenance, and test evidence.',
      '',
      'Begin integration verification.',
    ];
    return lines.join('\n');
  }
}

export const promptBuilder = new PromptBuilder();
