import type { Database } from "../../platform/database/database.js";
import type { ExecutionQueueProjection } from "@ebb-orchestrator/contracts";
import { schedulerEligibility, type SchedulerTaskRow } from "./dashboard-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
interface RunRow { id: string; role: string; task_id: string | null; status: string; }
type TaskRow = SchedulerTaskRow;
/**
 * Формирует read model execution-projection из авторитетного состояния оркестрации для API и UI.
 */
export class ExecutionProjection {
   constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}
  get(): ExecutionQueueProjection {
    if (!this.db) return { running: [], waiting: [], blocked: [] };
    const running = this.db.all<RunRow>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status }));
    const tasks = this.db.all<TaskRow>("SELECT id,status,project_id,wait_reason,contract_json FROM tasks WHERE status IN ('WAITING_FOR_DEPENDENCY','WAITING_FOR_APPROVAL','BLOCKED','READY') ORDER BY updated_at");
     const projected = tasks.map((t) => ({ taskId: t.id, eligibility: schedulerEligibility(this.db!, t, this.scheduler) }));
     const waiting = projected.flatMap((entry) => entry.eligibility.status === "WAIT" ? [{ taskId: entry.taskId, reason: entry.eligibility.reason }] : []);
     const blocked = projected.flatMap((entry) => entry.eligibility.status === "BLOCK" ? [{ taskId: entry.taskId, reason: entry.eligibility.reason }] : []);
     return { running, waiting, blocked };
  }
}
