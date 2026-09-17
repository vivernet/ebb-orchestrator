import type { Database } from "../../platform/database/database.js";
import type { ExecutionQueueProjection } from "@ebb-orchestrator/contracts";
import { schedulerWaitReason, type SchedulerTaskRow } from "./dashboard-projection.js";
interface RunRow { id: string; role: string; task_id: string | null; status: string; }
type TaskRow = SchedulerTaskRow;
export class ExecutionProjection {
  constructor(private readonly db?: Database) {}
  get(): ExecutionQueueProjection {
    if (!this.db) return { running: [], waiting: [], blocked: [] };
    const running = this.db.all<RunRow>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status }));
    const tasks = this.db.all<TaskRow>("SELECT id,status,project_id,wait_reason,contract_json FROM tasks WHERE status IN ('WAITING_FOR_DEPENDENCY','WAITING_FOR_APPROVAL','BLOCKED','READY') ORDER BY updated_at");
    return { running, waiting: tasks.map((t) => ({ taskId: t.id, reason: schedulerWaitReason(this.db!, t) })).filter((entry) => entry.reason !== null && entry.reason.code !== "BLOCKED").map((entry) => ({ taskId: entry.taskId, reason: entry.reason! })), blocked: tasks.filter((t) => t.status === "BLOCKED").map((t) => ({ taskId: t.id, reason: schedulerWaitReason(this.db!, t) ?? { code: "BLOCKED", message: "Blocked by workflow" } })) };
  }
}
