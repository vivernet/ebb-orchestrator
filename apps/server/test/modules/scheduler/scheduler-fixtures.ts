import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database, DatabaseTx } from "../../../src/platform/database/database.js";
import type { Migration } from "../../../src/platform/database/migrator.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import type { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";

/** Загружает историческую цепочку 001–030, которую фиксируют scheduler fixtures. */
export function loadSchedulerMigrations(): Migration[] {
  const directory = join(import.meta.dirname, "../../../src/platform/database/migrations");
  return readdirSync(directory).filter((file) => file.endsWith(".sql") && Number(file.slice(0, 3)) <= 30).sort().map((file) => {
    const migration = { version: Number(file.slice(0, 3)), name: file.slice(0, -4), sql: readFileSync(join(directory, file), "utf8") };
    return migration.version === 27 ? { ...migration, foreignKeys: "disabled" as const } : migration;
  });
}

export function seedActiveOnboarding(tx: DatabaseTx, projectId: string): void {
  const now = new Date().toISOString(); const approvalId = crypto.randomUUID();
  tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at,resolved_by,resolved_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','fixture',$now,'fixture',$now)", { id: approvalId, projectId, now });
  tx.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/repo','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId, now });
}

export function assertMissingOnboardingIsBlocked(scheduler: SchedulerService, projectId: string): void {
  const result = scheduler.getEligibility(`task-for-${projectId}`, { projectId });
  if (result.status !== "BLOCK" || result.reason !== "ONBOARDING_NOT_ACTIVE") throw new Error(`Expected ONBOARDING_NOT_ACTIVE, got ${JSON.stringify(result)}`);
}

export function migrateSchedulerFixture(db: Database): void { runMigrations(db, loadSchedulerMigrations()); }
