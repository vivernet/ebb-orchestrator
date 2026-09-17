import { describe, expect, it } from "vitest";
import { validateRoleOutput } from "../../../src/modules/runtime/output-validator.js";

const task = (ref: string, overrides: Record<string, unknown> = {}) => ({
  ref,
  title: `Task ${ref}`,
  acceptanceCriteria: ["The behavior is verified"],
  role: "middle_dev",
  workflow: "standard",
  dependsOn: [],
  ...overrides,
});

const plan = (tasks: unknown[]) => ({
  version: "1.0.0",
  operation: "PLAN",
  summary: "A plan",
  plan: { tasks },
});

describe("planning output validation", () => {
  it.each([
    ["duplicate task refs", [task("task_1"), task("task_1")], "duplicate"],
    ["unknown dependency ref", [task("task_1", { dependsOn: ["task_missing"] })], "unknown"],
    ["cyclic temporary dependency graph", [task("task_1", { dependsOn: ["task_2"] }), task("task_2", { dependsOn: ["task_1"] })], "cycle"],
  ])("rejects %s", (_name, tasks, expected) => {
    const result = validateRoleOutput("coordinator", plan(tasks));
    expect(result.valid).toBe(false);
    expect(result.error?.toLowerCase()).toContain(expected);
  });

  it("rejects an unknown role and workflow", () => {
    const result = validateRoleOutput("coordinator", plan([
      task("task_1", { role: "invented_role", workflow: "invented_workflow" }),
    ]));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unknown (role|workflow)/i);
  });

  it("rejects a task without acceptance criteria", () => {
    const result = validateRoleOutput("coordinator", plan([
      task("task_1", { acceptanceCriteria: [] }),
    ]));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/acceptance criteria/i);
  });
});
