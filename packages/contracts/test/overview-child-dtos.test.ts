import { expect, test } from "vitest";

import type { EpicOverviewProjection, TaskOverviewProjection } from "../src/api.js";

test("epic task DTO keeps the confirmed wire identifiers and labels", () => {
  const task: EpicOverviewProjection["tasks"][number] = {
    id: "task-1",
    display_id: "TASK-1",
    title: "Implement feature",
    status: "IN_PROGRESS",
  };
  const labels: [string, string, string, string] = [task.id, task.display_id, task.title, task.status];

  expect(task).toMatchObject({ id: "task-1", display_id: "TASK-1", title: "Implement feature", status: "IN_PROGRESS" });
  expect(labels).toEqual(["task-1", "TASK-1", "Implement feature", "IN_PROGRESS"]);
});

test("task run DTO keeps the confirmed wire identifier and UI labels", () => {
  const run: TaskOverviewProjection["runs"][number] = {
    id: "run-1",
    role: "Developer",
    status: "IN_PROGRESS",
  };
  const labels: [string, string, string] = [run.id, run.role, run.status];

  expect(run).toMatchObject({ id: "run-1", role: "Developer", status: "IN_PROGRESS" });
  expect(labels).toEqual(["run-1", "Developer", "IN_PROGRESS"]);
});
