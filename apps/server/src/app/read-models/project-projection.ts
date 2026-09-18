import type { Database } from "../../platform/database/database.js";
import type { EventProjection, ProjectOverviewProjection } from "@ebb-orchestrator/contracts";
import { DashboardProjection } from "./dashboard-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { persistedGitState } from "./git-state.js";
interface ProjectRow { id: string; name: string; display_name: string; status: string; }
interface WorkRow { id: string; epic_id?: string | null; display_id: string; title: string; status: string; required: number; contract_json: string; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class ProjectProjection {
  constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}
  get(id: string): ProjectOverviewProjection | undefined {
    if (!this.db) return undefined;
    const p = this.db.get<ProjectRow>("SELECT id,name,display_name,status FROM projects WHERE id=$id", { id });
    if (!p) return undefined;
    const epics = this.db.all<WorkRow>("SELECT id,display_id,title,status,contract_json FROM epics WHERE project_id=$id ORDER BY created_at", { id }).map(({ id, display_id, title, status }) => ({ id, display_id, title, status }));
    const tasks = this.db.all<WorkRow>("SELECT id,epic_id,display_id,title,status,required,contract_json FROM tasks WHERE project_id=$id ORDER BY created_at", { id }).map(({ id, epic_id, display_id, title, status, required }) => ({ id, epic_id: epic_id ?? null, display_id, title, status, required }));
    const approvals = this.db.all<{ id: string; type: string; status: string; created_at: string }>("SELECT id,type,status,created_at FROM approvals WHERE subject_id=$id OR subject_id IN (SELECT id FROM epics WHERE project_id=$id UNION ALL SELECT id FROM tasks WHERE project_id=$id) ORDER BY created_at", { id }).map((a) => ({ id: a.id, type: a.type, status: a.status, createdAt: a.created_at }));
    const blockers = this.db.all<{ id: string; status: string; reason: string | null }>("SELECT id,status,reason FROM recovery_state WHERE task_id IN (SELECT id FROM tasks WHERE project_id=$id) AND status NOT IN ('RESOLVED','DONE')", { id });
    const events = this.db.all<{ id: string; type: string; created_at: string; payload_json: string }>("SELECT id,type,created_at,payload_json FROM outbox_events WHERE aggregate_id=$id OR aggregate_id IN (SELECT id FROM epics WHERE project_id=$id UNION ALL SELECT id FROM tasks WHERE project_id=$id) ORDER BY created_at", { id }).map(eventProjection);
     const git = this.db.get<{ repository_path: string; branch_name: string | null; target_ref: string | null }>("SELECT go.repo_path repository_path,go.branch_name,go.target_ref FROM git_operations go JOIN tasks t ON go.branch_name='task/' || t.id WHERE t.project_id=$id ORDER BY go.created_at DESC LIMIT 1", { id });
     const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(cached_tokens),0) cachedTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE project_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
     const persistedGit = persistedGitState(this.db, id);
     return { project: { id: p.id, name: p.name, displayName: p.display_name, status: p.status }, git: { repositoryPath: git?.repository_path ?? persistedGit.repositoryPath, branch: git?.branch_name ?? null, defaultBranch: git?.target_ref ?? persistedGit.defaultBranch, github: persistedGit.github, worktreePath: null }, epics, tasks, approvals, blockers, events, usage };
  }
  list(): unknown[] { return this.db ? new DashboardProjection(this.db, this.scheduler).get().projects : []; }
}
function eventProjection(event: { id: string; type: string; created_at: string; payload_json: string }): EventProjection {
  let payload: unknown = event.payload_json;
  try { payload = JSON.parse(event.payload_json); } catch { /* preserve opaque payload */ }
  return { id: event.id, type: event.type, createdAt: event.created_at, payload };
}
