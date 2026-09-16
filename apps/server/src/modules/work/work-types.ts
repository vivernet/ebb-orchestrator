/**
 * Work domain types – Tasks, Epics, and Task Contracts.
 */

export type TaskStatus =
  | "DRAFT" | "READY" | "DEVELOPMENT" | "REVIEW" | "QA"
  | "READY_FOR_INTEGRATION" | "INTEGRATION" | "INTEGRATED_INTO_EPIC"
  | "READY_FOR_MERGE" | "MERGING" | "DONE" | "RELEASED"
  | "BLOCKED" | "WAITING_FOR_DEPENDENCY" | "WAITING_FOR_APPROVAL"
  | "PAUSED" | "FAILED" | "CANCELLED";

export type EpicStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export interface TaskContract {
  readonly version: number;
  readonly goal: string;
  readonly context: string;
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly nonGoals: readonly string[];
  readonly definitionOfDone: readonly string[];
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly epicId: string | null;
  readonly displayId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly contract: TaskContract;
  readonly required: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Epic {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: string;
  readonly title: string;
  readonly status: EpicStatus;
  readonly contract: TaskContract;
  readonly createdAt: string;
  readonly updatedAt: string;
}
