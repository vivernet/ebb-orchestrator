import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const acceptanceSource = readFileSync(
  new URL("./v1-autonomous-task.test.ts", import.meta.url),
  "utf8",
);

describe("real Hermes autonomous-task acceptance gate", () => {
  it("runs only when explicitly opted in and has no unconditional skip", () => {
    const marker = 'it("runs the real Hermes managed-worktree acceptance when opted in"';
    const start = acceptanceSource.lastIndexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const testBlock = acceptanceSource.slice(start);
    const end = testBlock.indexOf("\n  }, HERMES_LIVE_TEST_TIMEOUT_MS);");
    expect(end).toBeGreaterThan(0);
    const acceptanceTest = testBlock.slice(0, end);

    expect(acceptanceTest).toMatch(
      /if \(process\.env\.RUN_HERMES_E2E !== "1"\) skip\(/u,
    );
    expect(acceptanceTest).not.toMatch(/^\s*skip\(/mu);
    expect(acceptanceTest).not.toMatch(/^\s*return;\s*$/mu);
  });

  it("wires the real Hermes acceptance through the production process-scope supervisor", () => {
    const acceptanceStart = acceptanceSource.lastIndexOf(
      'it("runs the real Hermes managed-worktree acceptance when opted in"',
    );
    const acceptanceTest = acceptanceSource.slice(acceptanceStart);

    expect(acceptanceSource).toContain('import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";');
    expect(acceptanceSource).toContain('import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";');
    expect(acceptanceTest).toMatch(/const executor = new ProcessExecutor\(\);[\s\S]*?process\.platform === "win32"\s*\? new WindowsJobSupervisor\(executor\)\s*:\s*new SystemdRunSupervisor\(executor\);/u);
    expect(acceptanceTest).toMatch(/new HermesRuntimeAdapter\(executor, undefined, \{[\s\S]*?\}, supervisor\);/u);
  });

  it("seeds an approved onboarding workflow for the real Hermes capability binding", () => {
    expect(acceptanceSource).toMatch(/const onboardingApprovalId = randomUUID\(\);[\s\S]*?INSERT INTO approvals\(id,type,subject_id,subject_type,status,requested_by,created_at\) VALUES\(\$id,'WORKFLOW_CHANGE',\$projectId,'PROJECT','APPROVED'/u);
    expect(acceptanceSource).toMatch(/INSERT INTO onboarding_configs\(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at\)[\s\S]*?\$approvalId[\s\S]*?approvalId: onboardingApprovalId/u);
  });
});
