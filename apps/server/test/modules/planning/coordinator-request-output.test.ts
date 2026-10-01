import { describe, expect, it } from "vitest";
import { parseCoordinatorRequestOutput } from "../../../src/modules/planning/coordinator-request-output.js";

const tasks = [
  { ref: "task_one", title: "Foundation", acceptanceCriteria: ["works"], role: "developer", workflow: "standard", dependsOn: [] },
  { ref: "task_two", title: "Follow-up", acceptanceCriteria: ["works"], role: "developer", workflow: "standard", dependsOn: ["task_one"] },
];

describe("Coordinator request output", () => {
  it("accepts a validated Epic plan and binds its Project identity", () => {
    const result = parseCoordinatorRequestOutput({ version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: { title: "Feature" }, tasks } }, "project-1", "local-user");
    expect(result).toMatchObject({ classification: "EPIC", plan: { projectId: "project-1", requestedBy: "local-user", epic: { title: "Feature" } } });
  });

  it("rejects incoherent classification and malformed dependency graph", () => {
    expect(() => parseCoordinatorRequestOutput({ version: "1", operation: "PLAN", classification: "EPIC", plan: { tasks } }, "project-1", "local-user")).toThrow();
    expect(() => parseCoordinatorRequestOutput({ version: "1", operation: "PLAN", classification: "TASK", plan: { epic: { title: "Feature" }, tasks } }, "project-1", "local-user")).toThrow();
    expect(() => parseCoordinatorRequestOutput({ version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: { title: "Feature" }, tasks: [
      { ...tasks[0], dependsOn: ["task_two"] }, { ...tasks[1], dependsOn: ["task_one"] },
    ] } }, "project-1", "local-user")).toThrow();
  });

  it("accepts NEEDS_INPUT only without a plan", () => {
    expect(parseCoordinatorRequestOutput({ version: "1", operation: "CLASSIFY_REQUEST", classification: "NEEDS_INPUT" }, "project-1", "local-user"))
      .toEqual({ classification: "NEEDS_INPUT" });
    expect(() => parseCoordinatorRequestOutput({ version: "1", operation: "CLASSIFY_REQUEST", classification: "NEEDS_INPUT", plan: { tasks } }, "project-1", "local-user")).toThrow();
  });
});
