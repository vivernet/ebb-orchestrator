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
  /**
   * Build Developer prompt.
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

    // Task Contract
    lines.push('=== TASK CONTRACT ===');
    lines.push(`Task ID: ${input.taskContract.id}`);
    lines.push(`Priority: ${input.taskContract.priority}`);
    lines.push('');
    lines.push(`Goal: ${input.taskContract.goal}`);
    lines.push('');
    lines.push('Context:');
    lines.push(input.taskContract.context);
    lines.push('');

    // Requirements
    lines.push('Requirements:');
    input.taskContract.requirements.forEach((req) => {
      lines.push(`- ${req}`);
    });
    lines.push('');

    // Acceptance Criteria
    lines.push('Acceptance Criteria:');
    input.taskContract.acceptanceCriteria.forEach((ac) => {
      lines.push(`- ${ac}`);
    });
    lines.push('');

    // Definitions
    lines.push('Definition of Done:');
    input.taskContract.definitionOfDone.forEach((dod) => {
      lines.push(`- ${dod}`);
    });
    lines.push('');

    // Non-Goals
    lines.push('Non-Goals:');
    input.taskContract.nonGoals.forEach((ng) => {
      lines.push(`- ${ng}`);
    });
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

    // Decisions
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
   * Build Reviewer prompt.
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

    // Task Contract
    lines.push('=== TASK CONTRACT ===');
    lines.push(`Task ID: ${input.taskContract.id}`);
    lines.push(`Priority: ${input.taskContract.priority}`);
    lines.push('');
    lines.push(`Goal: ${input.taskContract.goal}`);
    lines.push('');
    lines.push('Context:');
    lines.push(input.taskContract.context);
    lines.push('');

    // Requirements
    lines.push('Requirements:');
    input.taskContract.requirements.forEach((req) => {
      lines.push(`- ${req}`);
    });
    lines.push('');

    // Acceptance Criteria
    lines.push('Acceptance Criteria:');
    input.taskContract.acceptanceCriteria.forEach((ac) => {
      lines.push(`- ${ac}`);
    });
    lines.push('');

    // Definition of Done
    lines.push('Definition of Done:');
    input.taskContract.definitionOfDone.forEach((dod) => {
      lines.push(`- ${dod}`);
    });
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

    // Decisions
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
    lines.push('=== REVIEW PROCESS ===');
    lines.push('1. Read the task contract carefully');
    lines.push('2. Review the changes in the diff');
    lines.push('3. Check against requirements and acceptance criteria');
    lines.push('4. Verify against guidelines and decisions');
    lines.push('5. Report PASS or list findings with severity');
    lines.push('');

    lines.push('Begin your review.');

    return lines.join('\n');
  }

  /**
   * Build QA prompt.
   */
  buildQAPrompt(input: {
    taskContract: TaskContract;
    environment?: string;
    defects?: Finding[];  // Defects to retest
  }): string {
    const lines: string[] = [];

    lines.push('You are a QA Agent.');
    lines.push('Verify the implementation against acceptance criteria.');
    lines.push('');

    // Task Contract - focus on acceptance criteria
    lines.push('=== ACCEPTANCE CRITERIA ===');
    input.taskContract.acceptanceCriteria.forEach((ac) => {
      lines.push(`- ${ac}`);
    });
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
}

export const promptBuilder = new PromptBuilder();
