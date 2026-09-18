import type { Database } from "../../platform/database/database.js";
import type { TaskOverviewProjection } from "@ebb-orchestrator/contracts";
import { schedulerWaitReason, type SchedulerTaskRow } from "./dashboard-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { persistedGitState } from "./git-state.js";
interface TaskRow extends SchedulerTaskRow { [key: string]: unknown; }
interface RunRow { id: string; role: string; runtime: string; model: string; status: string; started_at: string | null; ended_at: string | null; input_tokens: number | null; cached_input_tokens: number | null; output_tokens: number | null; cost: number | null; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class TaskProjection {
  constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}
  get(id: string): TaskOverviewProjection | undefined {
    if (!this.db) return undefined;
    const task = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id=$id", { id });
    if (!task) return undefined;
    const runs = this.db.all<RunRow>("SELECT id,role,runtime,model,status,started_at,ended_at,input_tokens,cached_input_tokens,output_tokens,cost FROM agent_runs WHERE task_id=$id ORDER BY started_at", { id });
    const dependencies = this.db.all<{ id: string; task_id: string; depends_on_task_id: string; type: string; status: string | null }>("SELECT d.id,d.task_id,d.depends_on_task_id,d.type,t.status FROM dependencies d LEFT JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$id", { id }).map((d) => ({ id: d.id, taskId: d.task_id, dependsOnTaskId: d.depends_on_task_id, type: d.type, status: d.status }));
    const findings = this.db.all("SELECT * FROM findings WHERE task_id=$id ORDER BY created_at", { id });
    const defects = this.db.all("SELECT * FROM defects WHERE task_id=$id ORDER BY created_at", { id });
    const approvals = this.db.all<{ id: string; type: string; status: string; created_at: string }>("SELECT id,type,status,created_at FROM approvals WHERE subject_id=$id ORDER BY created_at", { id }).map((a) => ({ id: a.id, type: a.type, status: a.status, createdAt: a.created_at }));
    const events = this.db.all<{ id: string; type: string; created_at: string; payload_json: string }>("SELECT id,type,created_at,payload_json FROM outbox_events WHERE aggregate_id=$id ORDER BY created_at", { id }).map((event) => ({ id: event.id, type: event.type, createdAt: event.created_at, payload: parseJson(event.payload_json) }));
    const git = this.db.get<{ repository_path: string; branch_name: string | null; target_ref: string | null; worktree_path: string | null }>("SELECT go.repo_path repository_path,go.branch_name,go.target_ref,w.path worktree_path FROM git_operations go LEFT JOIN worktrees w ON w.branch=go.branch_name AND w.removed_at IS NULL WHERE go.branch_name='task/' || $id ORDER BY go.created_at DESC LIMIT 1", { id });
     const contract = parseJson(task.contract_json ?? "{}");
     const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(cached_tokens),0) cachedTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE task_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
     const persistedGit = persistedGitState(this.db, String(task.project_id));
     // The workflow status is the authoritative, persisted stage.  Do not
     // infer a stage from runs or from the presence of a git operation.
     return { task, contract, lifecycle: { status: task.status, stage: task.status, updatedAt: String(task.updated_at ?? "") || null }, git: { repositoryPath: git?.repository_path ?? persistedGit.repositoryPath, branch: git?.branch_name ?? null, defaultBranch: git?.target_ref ?? persistedGit.defaultBranch, github: persistedGit.github, worktreePath: git?.worktree_path ?? null }, runs, findings, defects, dependencies, approvals, events, usage, waitReason: schedulerWaitReason(this.db, task, this.scheduler) };
  }
}
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
