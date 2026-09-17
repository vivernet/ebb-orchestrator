import type { Database } from "../../platform/database/database.js";
import type { ProjectOverviewProjection } from "@ebb-orchestrator/contracts";
import { DashboardProjection } from "./dashboard-projection.js";
export class ProjectProjection {
  constructor(private readonly db?: Database) {}
  get(id: string): ProjectOverviewProjection | undefined {
    if (!this.db) return undefined;
    const p = this.db.get<any>("SELECT id,name,display_name,status FROM projects WHERE id=$id", { id });
    if (!p) return undefined;
    const epics = this.db.all<any>("SELECT id,display_id,title,status,contract_json FROM epics WHERE project_id=$id ORDER BY created_at", { id });
    const tasks = this.db.all<any>("SELECT id,epic_id,display_id,title,status,required,contract_json FROM tasks WHERE project_id=$id ORDER BY created_at", { id });
    const usage = this.db.get<any>("SELECT COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(cached_tokens),0) cachedTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE project_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    return { project: { id: p.id, name: p.name, displayName: p.display_name, status: p.status }, epics, tasks, usage };
  }
  list(): unknown[] { return this.db ? new DashboardProjection(this.db).get().projects : []; }
}
