import { expect, test } from "vitest";

import type { EpicOverviewProjection, TaskOverviewProjection } from "../src/api.js";
import type {
  ApprovalInboxItemProjection,
  ProjectIndexRowProjection,
  TaskControlResponse,
  TaskPriorityResponse,
} from "../src/reference-projections.js";

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

test("project index row DTO keeps wire identifiers and display labels", () => {
  const row: ProjectIndexRowProjection = {
    id: "proj-1",
    name: "proj-1",
    displayName: "Ebb AI Hub",
    status: "ACTIVE",
    updatedAt: null,
  };

  expect(row).toMatchObject({ id: "proj-1", name: "proj-1", displayName: "Ebb AI Hub", status: "ACTIVE" });
  expect([row.id, row.displayName, row.status]).toEqual(["proj-1", "Ebb AI Hub", "ACTIVE"]);
});

test("approval inbox item DTO keeps wire identifiers, priority and status", () => {
  const item: ApprovalInboxItemProjection = {
    id: "a-1",
    category: "EPIC_PLAN_CHANGE",
    status: "PENDING",
    priority: "HIGH",
    projectId: "proj-1",
    title: "EPIC-42 · Изменение плана",
    createdAt: "2026-10-25T12:00:00.000Z",
    resolvedAt: null,
  };

  expect(item).toMatchObject({
    id: "a-1",
    status: "PENDING",
    priority: "HIGH",
    projectId: "proj-1",
    title: "EPIC-42 · Изменение плана",
  });
});

test("task priority and control response DTOs keep confirmed backend fields", () => {
  const priority: TaskPriorityResponse = { taskId: "task-1", priority: 42, updatedAt: "2026-10-25T12:00:00.000Z" };
  const control: TaskControlResponse = {
    taskId: "task-1",
    state: "PAUSED",
    priorStage: "READY",
    updatedAt: "2026-10-25T12:00:00.000Z",
  };

  expect(priority).toMatchObject({ taskId: "task-1", priority: 42 });
  expect(control).toMatchObject({ taskId: "task-1", state: "PAUSED", priorStage: "READY" });
});
