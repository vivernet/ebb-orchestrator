import type { Database } from "../../platform/database/database.js";
import type { EpicOverviewProjection } from "@ebb-orchestrator/contracts";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
interface EpicRow { [key: string]: unknown; id: string; }
interface TaskRow { id: string; display_id: string; title: string; status: string; required: number; contract_json: string; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
export class EpicProjection {
  constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}
  get(id: string): EpicOverviewProjection | undefined {
    if (!this.db) return undefined;
    const epic = this.db.get<EpicRow>("SELECT * FROM epics WHERE id=$id", { id });
    if (!epic) return undefined;
    const tasks = this.db.all<TaskRow>("SELECT id,display_id,title,status,required,contract_json FROM tasks WHERE epic_id=$id ORDER BY created_at", { id });
    const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_tokens),0) cachedTokens, COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE epic_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    return { epic, tasks, usage };
  }
}
