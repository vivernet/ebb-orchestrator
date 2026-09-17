import type { Database } from "../../platform/database/database.js";
import type { TaskOverviewProjection } from "@ebb-orchestrator/contracts";
import { schedulerWaitReason, type SchedulerTaskRow } from "./dashboard-projection.js";
interface TaskRow extends SchedulerTaskRow { [key: string]: unknown; }
interface RunRow { id: string; role: string; runtime: string; model: string; status: string; started_at: string | null; ended_at: string | null; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; cost: number | null; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
export class TaskProjection {
  constructor(private readonly db?: Database) {}
  get(id: string): TaskOverviewProjection | undefined {
    if (!this.db) return undefined;
    const task = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id=$id", { id });
    if (!task) return undefined;
    const runs = this.db.all<RunRow>("SELECT id,role,runtime,model,status,started_at,ended_at,input_tokens,cached_input_tokens,output_tokens,cost FROM agent_runs WHERE task_id=$id ORDER BY started_at", { id });
    const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(cached_tokens),0) cachedTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE task_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    return { task, runs, findings: [], defects: [], usage, waitReason: schedulerWaitReason(this.db, task) };
  }
}
