import type { Database } from "../../platform/database/database.js";
import type { DashboardProjection as Dashboard } from "@ebb-orchestrator/contracts";
import type { WaitReason } from "@ebb-orchestrator/contracts";

const emptyUsage = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
interface ProjectRow { id: string; name: string; display_name: string; status: string; }
interface AgentRow { id: string; role: string; task_id: string | null; status: string; }
export interface SchedulerTaskRow { id: string; title?: string; status: string; project_id: string; wait_reason: string | null; contract_json?: string; }
interface UsageRow { inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number; }
interface CountRow { count: number; }
function hasTable(db: Database, name: string): boolean { return Boolean(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=$name", { name })); }

export class DashboardProjection {
  constructor(private readonly db?: Database) {}
  get(): Dashboard {
    if (!this.db) return { activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage(), projects: [] };
    const db = this.db;
    const projects = hasTable(db, "projects") ? db.all<ProjectRow>("SELECT id,name,display_name,status FROM projects ORDER BY name").map((p) => ({ id: p.id, name: p.name, displayName: p.display_name, status: p.status })) : [];
    const activeAgents = hasTable(db, "agent_runs") ? db.all<AgentRow>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status })) : [];
    const activeWork = hasTable(db, "tasks") ? db.all<SchedulerTaskRow>("SELECT id,title,status,project_id,wait_reason,contract_json FROM tasks WHERE status NOT IN ('DONE','CANCELLED','RELEASED') ORDER BY updated_at").map((t) => ({ id: t.id, title: t.title ?? "", status: t.status, waitReason: schedulerWaitReason(db, t) })) : [];
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
export function schedulerWaitReason(db: Database, task: SchedulerTaskRow): WaitReason | null {
  if (task.wait_reason) {
    try { return JSON.parse(task.wait_reason) as WaitReason; } catch { return { code: task.wait_reason, message: task.wait_reason }; }
  }
  if (hasTable(db, "dependencies")) {
    const dependency = db.get<{ id: string; title: string }>("SELECT t.id,t.title FROM dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$id AND t.status NOT IN ('DONE','RELEASED','CANCELLED','INTEGRATED_INTO_EPIC') ORDER BY t.id LIMIT 1", { id: task.id });
    if (dependency) return { code: "DEPENDENCY", message: "Waiting for a blocking dependency", details: { dependencyId: dependency.id, dependencyTitle: dependency.title } };
  }
  if (hasTable(db, "approvals") && db.get("SELECT id FROM approvals WHERE subject_id=$id AND status='PENDING' LIMIT 1", { id: task.id })) return { code: "APPROVAL", message: "Waiting for approval", details: { subjectId: task.id } };
  if (hasTable(db, "scheduler_resource_locks") && db.get<{ owner_id: string }>("SELECT owner_id FROM scheduler_resource_locks WHERE resource_key IN ('global',$key) AND owner_id<>$owner LIMIT 1", { key: `task:${task.id}`, owner: `task:${task.id}` })) return { code: "RESOURCE_LOCK", message: "Waiting for a resource lock", details: { resourceKey: `task:${task.id}` } };
  if (hasTable(db, "scheduler_budgets")) {
    const budget = db.get<{ limit_cost: number; spent_cost: number; reserved_cost: number }>("SELECT limit_cost,spent_cost,reserved_cost FROM scheduler_budgets WHERE project_id=$project_id", { project_id: task.project_id });
    if (budget && budget.spent_cost + budget.reserved_cost >= budget.limit_cost) return { code: "BUDGET", message: "Waiting for project budget", details: { projectId: task.project_id, limit: budget.limit_cost } };
  }
  if (hasTable(db, "agent_runs") && task.contract_json) {
    let requestedRole: string | undefined;
    try { requestedRole = (JSON.parse(task.contract_json) as { role?: string }).role?.toLowerCase(); } catch { requestedRole = undefined; }
    if (requestedRole === "reviewer") {
      const activeReviewers = db.get<CountRow>("SELECT COUNT(*) AS count FROM agent_runs WHERE lower(role)='reviewer' AND status IN ('STARTED','IN_PROGRESS','COMPLETING')")?.count ?? 0;
      if (activeReviewers >= 1) return { code: "ROLE_SLOT", message: "Waiting for reviewer role slot", details: { role: "reviewer", limit: 1, running: activeReviewers } };
    }
  }
  if (hasTable(db, "scheduler_reservations")) {
    const global = db.get<CountRow>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind<>'LOCK'")?.count ?? 0;
    if (global >= 4) return { code: "GLOBAL_LIMIT", message: "Waiting for global scheduler capacity", details: { limit: 4, running: global } };
    const project = db.get<CountRow>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$project_id AND status='RESERVED' AND kind<>'LOCK'", { project_id: task.project_id })?.count ?? 0;
    if (project >= 3) return { code: "PROJECT_LIMIT", message: "Waiting for project scheduler capacity", details: { limit: 3, running: project } };
  }
  return waitReason(task.status);
}
