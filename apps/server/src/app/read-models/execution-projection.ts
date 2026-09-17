import type { Database } from "../../platform/database/database.js";
import type { ExecutionQueueProjection } from "@ebb-orchestrator/contracts";
import { waitReason } from "./dashboard-projection.js";
export class ExecutionProjection {
  constructor(private readonly db?: Database) {}
  get(): ExecutionQueueProjection {
    if (!this.db) return { running: [], waiting: [], blocked: [] };
    const running = this.db.all<any>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status }));
    const tasks = this.db.all<any>("SELECT id,status FROM tasks WHERE status IN ('WAITING_FOR_DEPENDENCY','WAITING_FOR_APPROVAL','BLOCKED') ORDER BY updated_at");
    return { running, waiting: tasks.filter((t) => t.status.startsWith("WAITING")).map((t) => ({ taskId: t.id, reason: waitReason(t.status)! })), blocked: tasks.filter((t) => t.status === "BLOCKED").map((t) => ({ taskId: t.id, reason: waitReason(t.status)! })) };
  }
}
