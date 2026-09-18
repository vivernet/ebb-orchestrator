import type { Database } from "../../platform/database/database.js";
import type { EpicOverviewProjection } from "@ebb-orchestrator/contracts";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { persistedGitState } from "./git-state.js";
interface EpicRow { [key: string]: unknown; id: string; }
interface TaskRow { id: string; display_id: string; title: string; status: string; required: number; contract_json: string; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
/**
 * Формирует read model epic-projection из авторитетного состояния оркестрации для API и UI.
 */
export class EpicProjection {
  constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}
  get(id: string): EpicOverviewProjection | undefined {
    if (!this.db) return undefined;
    const epic = this.db.get<EpicRow>("SELECT * FROM epics WHERE id=$id", { id });
    if (!epic) return undefined;
    const tasks = this.db.all<TaskRow>("SELECT id,display_id,title,status,required,contract_json FROM tasks WHERE epic_id=$id ORDER BY created_at", { id });
    const contract = parseJson((epic.contract_json as string) ?? "{}");
     const lifecycleRow = this.db.get<{ stage: string; updated_at: string; sequence_json: string }>("SELECT stage,updated_at,sequence_json FROM epic_orchestrations WHERE epic_id=$id", { id });
    const approvals = this.db.all<{ id: string; type: string; status: string; created_at: string }>("SELECT id,type,status,created_at FROM approvals WHERE subject_id=$id ORDER BY created_at", { id }).map((a) => ({ id: a.id, type: a.type, status: a.status, createdAt: a.created_at }));
    const blockers = this.db.all<{ id: string; status: string; reason: string | null }>("SELECT id,status,reason FROM recovery_state WHERE task_id IN (SELECT id FROM tasks WHERE epic_id=$id) AND status NOT IN ('RESOLVED','DONE')", { id });
    const events = this.db.all<{ id: string; type: string; created_at: string; payload_json: string }>("SELECT id,type,created_at,payload_json FROM outbox_events WHERE aggregate_id=$id ORDER BY created_at", { id }).map(event => ({ id: event.id, type: event.type, createdAt: event.created_at, payload: parseJson(event.payload_json) }));
     const git = this.db.get<{ repository_path: string; branch_name: string | null; target_ref: string | null }>("SELECT repo_path repository_path,branch_name,target_ref FROM git_operations WHERE branch_name='epic/' || $id ORDER BY created_at DESC LIMIT 1", { id });
     const usage = this.db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_tokens),0) cachedTokens, COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(actual_cost),0) cost FROM usage_records WHERE epic_id=$id", { id }) ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
     const persistedGit = persistedGitState(this.db, String(epic.project_id));
     const lifecycle = epicLifecycle(String(epic.status), lifecycleRow);
     return { epic, contract, lifecycle, git: { repositoryPath: git?.repository_path ?? persistedGit.repositoryPath, branch: git?.branch_name ?? null, defaultBranch: git?.target_ref ?? persistedGit.defaultBranch, github: persistedGit.github, worktreePath: null }, tasks, approvals, blockers, events, usage };
  }
}
const EPIC_STAGES = [
  ["EPIC_REVIEW", "Epic Review"],
  ["ARCHITECTURE_REVIEW", "Architecture Review"],
  ["EPIC_QA", "Epic QA"],
  ["INTEGRATION", "Merge"],
  ["FINAL_APPROVAL", "Merge approval"],
  ["DONE", "Done"],
] as const;
function epicLifecycle(status: string, row?: { stage: string; updated_at: string; sequence_json: string }) {
  const current = row?.stage ?? null;
  let sequence: string[] = [];
  try { sequence = row ? JSON.parse(row.sequence_json) as string[] : []; } catch { sequence = []; }
  const architectureApplicable = sequence.includes("architecture_review") || current === "ARCHITECTURE_REVIEW";
  const stages = EPIC_STAGES.filter(([id]) => id !== "ARCHITECTURE_REVIEW" || architectureApplicable).map(([id, label]) => {
    const completed = id === "DONE" ? current === "DONE" : sequence.includes(id.toLowerCase());
    const isCurrent = current === id;
    return { id, label, status: isCurrent ? "CURRENT" as const : completed ? "COMPLETED" as const : "PENDING" as const, updatedAt: row?.updated_at ?? null };
  });
  return { status, stage: current, updatedAt: row?.updated_at ?? null, stages };
}
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return value; } }
