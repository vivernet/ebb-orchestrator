import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const acceptanceSource = readFileSync(
  new URL("./v1-autonomous-task.test.ts", import.meta.url),
  "utf8",
);

describe("real Hermes autonomous-task acceptance gate", () => {
  it("runs only when explicitly opted in and has no unconditional skip", () => {
    const marker = 'it("runs the real Hermes managed-worktree acceptance when opted in"';
    const start = acceptanceSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const testBlock = acceptanceSource.slice(start);
    const end = testBlock.indexOf("\n  }, 240000);");
    expect(end).toBeGreaterThan(0);
    const acceptanceTest = testBlock.slice(0, end);

    expect(acceptanceTest).toMatch(
      /if \(process\.env\.RUN_HERMES_E2E !== "1"\) skip\(/u,
    );
    expect(acceptanceTest).not.toMatch(/^\s*skip\(/mu);
    expect(acceptanceTest).not.toMatch(/^\s*return;\s*$/mu);
  });
});
