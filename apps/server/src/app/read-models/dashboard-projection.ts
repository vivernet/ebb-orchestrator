import type { Database } from "../../platform/database/database.js";
import type { DashboardProjection as Dashboard } from "@ebb-orchestrator/contracts";

const emptyUsage = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
function hasTable(db: Database, name: string): boolean { return Boolean(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=$name", { name })); }

export class DashboardProjection {
  constructor(private readonly db?: Database) {}
  get(): Dashboard {
    if (!this.db) return { activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage(), projects: [] };
    const db = this.db;
    const projects = hasTable(db, "projects") ? db.all<any>("SELECT id,name,display_name,status FROM projects ORDER BY name").map((p) => ({ id: p.id, name: p.name, displayName: p.display_name, status: p.status })) : [];
    const activeAgents = hasTable(db, "agent_runs") ? db.all<any>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at").map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status })) : [];
    const activeWork = hasTable(db, "tasks") ? db.all<any>("SELECT id,title,status FROM tasks WHERE status NOT IN ('DONE','CANCELLED','RELEASED') ORDER BY updated_at").map((t) => ({ id: t.id, title: t.title, status: t.status, waitReason: waitReason(t.status) })) : [];
    const approvals = hasTable(db, "approvals") ? Number(db.get<any>("SELECT COUNT(*) AS count FROM approvals WHERE status='PENDING'")?.count ?? 0) : 0;
    const usage = hasTable(db, "usage_records") ? db.get<any>("SELECT COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(cached_tokens),0) cachedTokens, COALESCE(SUM(output_tokens),0) outputTokens, COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(actual_cost),0) cost FROM usage_records") : emptyUsage();
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
