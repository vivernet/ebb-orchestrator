import type { Database } from "../../platform/database/database.js";
import type { DashboardProjection as Dashboard } from "@ebb-orchestrator/contracts";
import type { WaitReason } from "@ebb-orchestrator/contracts";
import { SchedulerService } from "../../modules/scheduler/scheduler-service.js";

const emptyUsage = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
interface ProjectRow { id: string; name: string; display_name: string; status: string; }
interface AgentRow { id: string; role: string; task_id: string | null; status: string; }
export interface SchedulerTaskRow { id: string; title?: string; status: string; project_id: string; wait_reason: string | null; contract_json?: string; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
interface CountRow { count: number; }
function hasTable(db: Database, name: string): boolean { return Boolean(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=$name", { name })); }

export class DashboardProjection {
  private readonly scheduler: SchedulerService | undefined;

  constructor(private readonly db?: Database, scheduler?: SchedulerService) { this.scheduler = scheduler; }
  get(): Dashboard {
    if (!this.db) return { activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage(), projects: [] };
    const db = this.db;
    const projects = hasTable(db, "projects") ? db.all<ProjectRow>("SELECT id,name,display_name,status FROM projects ORDER BY name").map((p) => ({ id: p.id, name: p.name, displayName: p.display_name, status: p.status })) : [];
    const activeAgents = hasTable(db, "agent_runs") ? db.all<AgentRow>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status })) : [];
    const activeWork = hasTable(db, "tasks") ? db.all<SchedulerTaskRow>("SELECT id,title,status,project_id,wait_reason,contract_json FROM tasks WHERE status NOT IN ('DONE','CANCELLED','RELEASED') ORDER BY updated_at").map((t) => ({ id: t.id, title: t.title ?? "", status: t.status, waitReason: schedulerWaitReason(db, t, this.scheduler) })) : [];
    const approvals = hasTable(db, "approvals") ? Number(db.get<CountRow>("SELECT COUNT(*) AS count FROM approvals WHERE status='PENDING'")?.count ?? 0) : 0;
    const usage = hasTable(db, "usage_records") ? (db.get<UsageRow>("SELECT COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_tokens),0) cachedTokens, COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(actual_cost),0) cost FROM usage_records") ?? emptyUsage()) : emptyUsage();
    return { activeAgents, activeWork, approvals, usage, projects };
  }
}
export function waitReason(status: string): { code: string; message: string } | null {
  if (status === "WAITING_FOR_DEPENDENCY") return { code: "DEPENDENCY", message: "Waiting for a blocking dependency" };
  if (status === "WAITING_FOR_APPROVAL") return { code: "APPROVAL", message: "Waiting for approval" };
  if (status === "BLOCKED") return { code: "BLOCKED", message: "Blocked by workflow or policy" };
  if (status === "PAUSED") return { code: "PAUSED", message: "Paused by user" };
  return null;
}

/** Read the scheduler's durable evidence, rather than inferring from status. */
export function schedulerWaitReason(db: Database, task: SchedulerTaskRow, scheduler?: SchedulerService): WaitReason | null {
   const authoritativeScheduler = scheduler;
   if (!authoritativeScheduler) return waitReason(task.status);
  const eligibility = authoritativeScheduler.getEligibility(task.id, { projectId: task.project_id });
  const schedulerReason = eligibility.status === "WAIT" ? eligibility.reason : authoritativeScheduler.getWaitReason(task.id);
  if (schedulerReason) return schedulerReasonToProjection(schedulerReason, task);
  return waitReason(task.status);
}

function schedulerReasonToProjection(reason: string, task: SchedulerTaskRow): WaitReason {
  const messages: Record<string, string> = {
    WAITING_FOR_CAPACITY: "Waiting for scheduler capacity",
    WAITING_FOR_ROLE_CAPACITY: "Waiting for scheduler role capacity",
    WAITING_FOR_DEPENDENCY: "Waiting for a blocking dependency",
    WAITING_FOR_RESOURCE_LOCK: "Waiting for a resource lock",
    WAITING_FOR_BUDGET: "Waiting for project budget",
    WAITING_FOR_APPROVAL: "Waiting for approval",
  };
  return { code: reason, message: messages[reason] ?? reason, details: { taskId: task.id, projectId: task.project_id } };
}
