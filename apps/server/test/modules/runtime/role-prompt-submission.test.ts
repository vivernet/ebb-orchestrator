import { describe, expect, it } from "vitest";
import { DEVELOPER_COMMIT_SHA_INSTRUCTION, PromptBuilder } from "../../../src/modules/runtime/prompt-builder.js";
import { taskDeveloperPrompt, taskQaPrompt, taskReviewerPrompt } from "../../../src/modules/runtime/run-service.js";

const builder = new PromptBuilder();
const contract = {
  id: "TASK-1", goal: "Verify the assigned task", context: "Managed workspace",
  requirements: ["Preserve structured result validation"], acceptanceCriteria: ["Result is submitted"],
  dependencies: [], nonGoals: [], definitionOfDone: ["Observed evidence is recorded"], priority: "p1" as const,
};

describe("Plan04 role prompt submission tool", () => {
  it("documents explicit stable Reviewer and QA record updates", () => {
    const reviewerPrompt = builder.buildReviewerPrompt({ taskContract: contract, findings: [{ id: "FINDING-4", status: "in_progress", title: "Existing", severity: "high" }] });
    const qaPrompt = builder.buildQAPrompt({ taskContract: contract, defects: [{ id: "DEFECT-7", status: "in_progress", title: "Existing", severity: "high" }] });
    expect(reviewerPrompt).toContain("finding_updates with that exact FINDING-n");
    expect(reviewerPrompt).toContain("FINDING-4");
    expect(qaPrompt).toContain("defect_updates with that exact DEFECT-n");
    expect(qaPrompt).toContain("DEFECT-7");
    expect(qaPrompt).toContain("AC-1");
  });

  it.each([
    { role: "Developer", build: () => builder.buildDeveloperPrompt({ taskContract: contract }) },
    { role: "Reviewer", build: () => builder.buildReviewerPrompt({ taskContract: contract }) },
    { role: "QA", build: () => builder.buildQAPrompt({ taskContract: contract }) },
    { role: "Integration", build: () => builder.buildIntegrationPrompt({ taskContract: contract }) },
    { role: "direct Task Developer", build: taskDeveloperPrompt },
    { role: "direct Task Reviewer", build: taskReviewerPrompt },
    { role: "direct Task QA", build: taskQaPrompt },
  ])("requires $role to submit version 1.0.0", ({ build }) => {
    expect(build()).toContain('Set the structured result version exactly to "1.0.0".');
  });

  it.each([
    { role: "Developer", build: () => builder.buildDeveloperPrompt({ taskContract: contract }) },
    { role: "Reviewer", build: () => builder.buildReviewerPrompt({ taskContract: contract }) },
    { role: "QA", build: () => builder.buildQAPrompt({ taskContract: contract }) },
    { role: "Integration", build: () => builder.buildIntegrationPrompt({ taskContract: contract }) },
    { role: "direct Task Developer", build: taskDeveloperPrompt },
    { role: "direct Task Reviewer", build: taskReviewerPrompt },
    { role: "direct Task QA", build: taskQaPrompt },
  ])("instructs $role to call the exact tool registered by Hermes", ({ build }) => {
    const prompt = build();
    expect(prompt).toContain("mcp__ebb_orchestrator__submit_result");
    expect(prompt).not.toMatch(/(?:Call|calling|using) submit_result\b/);
  });

  it.each([
    { role: "Developer", build: () => builder.buildDeveloperPrompt({ taskContract: contract }) },
    { role: "Reviewer", build: () => builder.buildReviewerPrompt({ taskContract: contract }) },
    { role: "QA", build: () => builder.buildQAPrompt({ taskContract: contract }) },
    { role: "Integration", build: () => builder.buildIntegrationPrompt({ taskContract: contract }) },
    { role: "direct Task Developer", build: taskDeveloperPrompt },
    { role: "direct Task Reviewer", build: taskReviewerPrompt },
    { role: "direct Task QA", build: taskQaPrompt },
  ])("allows validation correction before one successful $role submission", ({ build }) => {
    const prompt = build();
    expect(prompt).toContain("If submit_result returns a validation error, correct the payload and retry.");
    expect(prompt).toContain("After a successful submission, do not call submit_result again.");
    expect(prompt).not.toMatch(/submit_result exactly once|exactly once[^\n]*submit_result/i);
  });

  it.each([
    { role: "role Developer", build: () => builder.buildDeveloperPrompt({ taskContract: contract }) },
    { role: "direct Task Developer", build: taskDeveloperPrompt },
  ])("requires $role to submit the exact full commit SHA", ({ build }) => {
    const prompt = build();
    expect(prompt).toContain(DEVELOPER_COMMIT_SHA_INSTRUCTION);
    if (build === taskDeveloperPrompt || prompt.includes("DEVELOPMENT: implement")) {
      expect(prompt).toContain("git.add");
      expect(prompt).toContain("git.head");
      expect(prompt).toContain('"outcome":"COMPLETED"');
      expect(prompt).toContain('"commitSha"');
      expect(prompt).toContain("<exact full SHA returned by git.head>");
    }
  });

  it("guides Developer through an expected failing baseline, implementation, passing tests, and exact commit evidence", () => {
    const prompt = builder.buildDeveloperPrompt({ taskContract: contract });
    const baseline = prompt.indexOf("Run project.test before changing files");
    const inspect = prompt.indexOf("its failure and relevant source with workspace.read and workspace.search");
    const searchReturnsPaths = prompt.indexOf("workspace.search returns file paths only");
    const readReturnedFiles = prompt.indexOf("Use workspace.read on relevant source/test paths returned by workspace.search and inspect their contents before choosing workspace.patch.");
    const patchContract = prompt.indexOf("For workspace.patch use {path, patches:[{start,end,content}]}: start/end are zero-based UTF-16 offsets and [start,end) is end-exclusive. Patches must be ascending, non-overlapping replacements; content replaces each range.");
    const implement = prompt.indexOf("use workspace.patch to implement the required change");
    const retest = prompt.indexOf("rerun project.test until it passes");
    const stageAndCommit = prompt.indexOf("Stage only the changed files with git.add");
    const inspectBeforeBlocked = prompt.indexOf("Before returning BLOCKED, inspect relevant source with workspace.read; a baseline red alone is not a blocker.");

    expect(baseline).toBeGreaterThanOrEqual(0);
    expect(inspect).toBeGreaterThan(baseline);
    expect(searchReturnsPaths).toBeGreaterThan(inspect);
    expect(readReturnedFiles).toBeGreaterThan(searchReturnsPaths);
    expect(patchContract).toBeGreaterThan(readReturnedFiles);
    expect(implement).toBeGreaterThan(patchContract);
    expect(implement).toBeGreaterThan(inspect);
    expect(retest).toBeGreaterThan(implement);
    expect(stageAndCommit).toBeGreaterThan(retest);
    expect(inspectBeforeBlocked).toBeGreaterThan(baseline);
    expect(prompt).toContain("A pre-change test failure that matches an acceptance criterion is expected, not by itself a reason to return BLOCKED.");
  });

  it("keeps Integration provenance verification in deterministic core and within the assigned workspace", () => {
    const prompt = builder.buildIntegrationPrompt({
      taskContract: contract,
      workspace: "C:/work/integration",
      expectedTargetSha: "a".repeat(40),
      sourceSha: "b".repeat(40),
      integrationAttemptId: "attempt-123",
      provenanceDatabasePath: "C:/private/.ebb-orchestrator/state.sqlite",
    });

    expect(prompt).not.toContain("C:/private/.ebb-orchestrator/state.sqlite");
    expect(prompt).toContain("the Orchestrator verifies persisted provenance deterministically");
    expect(prompt).toContain("Do not try to read the Orchestrator database or files outside the assigned workspace.");
    expect(prompt).toContain("integration_attempt:attempt-123");
  });
});
