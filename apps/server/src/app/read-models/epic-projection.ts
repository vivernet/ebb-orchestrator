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
    const contract = parseJson((epic.contract_json as string) ?? "{}");
    const lifecycleRow = this.db.get<{ stage: string; updated_at: string }>("SELECT stage,updated_at FROM epic_orchestrations WHERE epic_id=$id", { id });
    const approvals = this.db.all<{ id: string; type: string; status: string; created_at: string }>("SELECT id,type,status,created_at FROM approvals WHERE subject_id=$id ORDER BY created_at", { id }).map((a) => ({ id: a.id, type: a.type, status: a.status, createdAt: a.created_at }));
    const blockers = this.db.all<{ id: string; status: string; reason: string | null }>("SELECT id,status,reason FROM recovery_state WHERE task_id IN (SELECT id FROM tasks WHERE epic_id=$id) AND status NOT IN ('RESOLVED','DONE')", { id });
    const events = this.db.all<{ id: string; type: string; created_at: string; payload_json: string }>("SELECT id,type,created_at,payload_json FROM outbox_events WHERE aggregate_id=$id ORDER BY created_at", { id }).map(event => ({ id: event.id, type: event.type, createdAt: event.created_at, payload: parseJson(event.payload_json) }));
    const git = this.db.get<{ repository_path: string; branch_name: string | null; target_ref: string | null }>("SELECT repo_path repository_path,branch_name,target_ref FROM git_operations WHERE branch_name='epic/' || $id ORDER BY created_at DESC LIMIT 1", { id });
    const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_tokens),0) cachedTokens, COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE epic_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    return { epic, contract, lifecycle: { status: String(epic.status), stage: lifecycleRow?.stage ?? null, updatedAt: lifecycleRow?.updated_at ?? null }, git: { repositoryPath: git?.repository_path ?? null, branch: git?.branch_name ?? null, defaultBranch: git?.target_ref ?? null, github: null, worktreePath: null }, tasks, approvals, blockers, events, usage };
  }
}
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
