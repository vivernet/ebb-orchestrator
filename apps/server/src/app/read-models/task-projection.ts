import type { Database } from "../../platform/database/database.js";
import type { TaskOverviewProjection } from "@ebb-orchestrator/contracts";
import { waitReason } from "./dashboard-projection.js";
export class TaskProjection {
  constructor(private readonly db?: Database) {}
  get(id: string): TaskOverviewProjection | undefined {
    if (!this.db) return undefined;
    const task = this.db.get<any>("SELECT * FROM tasks WHERE id=$id", { id });
    if (!task) return undefined;
    const runs = this.db.all<any>("SELECT id,role,runtime,model,status,started_at,ended_at,input_tokens,cached_input_tokens,output_tokens,cost FROM agent_runs WHERE task_id=$id ORDER BY started_at", { id });
    const usage = this.db.get<any>("SELECT COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(cached_tokens),0) cachedTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE task_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    return { task, runs, findings: [], defects: [], usage, waitReason: waitReason(task.status) };
  }
}
