import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadSchedulerMigrations } from "./scheduler-fixtures.js";

const fixtureModes: Record<string, "active-onboarding" | "missing-onboarding" | "no-dispatch"> = {
  "modules/scheduler/scheduler.test.ts": "active-onboarding",
  "platform/database/scheduler-migration.test.ts": "no-dispatch",
  "platform/diagnostics/diagnostics.test.ts": "no-dispatch",
  "app/api.test.ts": "active-onboarding",
  "app/runs-dispatch.test.ts": "missing-onboarding",
  "app/security.test.ts": "no-dispatch",
  "app/health.test.ts": "no-dispatch",
  "app/settings-route.test.ts": "no-dispatch",
  "app/dependencies-routes.test.ts": "active-onboarding",
  "app/web-assets.test.ts": "no-dispatch",
  "app/final-merge-route.test.ts": "active-onboarding",
  "app/epic-routes.test.ts": "active-onboarding",
  "e2e/transport-origin.test.ts": "no-dispatch",
  "e2e/epic.fake-runtime.test.ts": "active-onboarding",
  "e2e/v1-epic.test.ts": "active-onboarding",
  "scenarios/standalone-task.fake-runtime.test.ts": "active-onboarding",
  "scenarios/epic.fake-runtime.test.ts": "active-onboarding",
  "modules/runtime/run-event-handlers.test.ts": "missing-onboarding",
  "modules/planning/epic-orchestrator-integration.test.ts": "missing-onboarding",
  "modules/git/task-workspace-provisioner.test.ts": "active-onboarding",
};

const runtimeSources = [
  "src/modules/scheduler/scheduler-service.ts",
  "src/modules/scheduler/resource-lock-service.ts",
  "src/app/routes/runs.ts",
  "src/modules/runtime/run-event-handlers.ts",
  "src/modules/planning/epic-orchestrator.ts",
];

describe("closed scheduler fixture and authority inventory", () => {
  it("enumerates every named fixture with exactly one explicit mode", () => {
    const testRoot = join(import.meta.dirname, "../../..");
    expect(Object.keys(fixtureModes)).toHaveLength(20);
    for (const [relative, mode] of Object.entries(fixtureModes)) {
      expect(readFileSync(join(testRoot, "test", relative), "utf8")).toBeTruthy();
      expect(["active-onboarding", "missing-onboarding", "no-dispatch"]).toContain(mode);
    }
    expect(Object.values(fixtureModes).filter((mode) => mode === "active-onboarding").length).toBeGreaterThan(0);
    expect(Object.values(fixtureModes).filter((mode) => mode === "missing-onboarding").length).toBeGreaterThan(0);
    expect(Object.values(fixtureModes).filter((mode) => mode === "no-dispatch").length).toBeGreaterThan(0);
  });

  it("loads the complete ordered 001-027 chain and excludes immutable 013/014 from runtime authority", () => {
    const migrations = loadSchedulerMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual(Array.from({ length: 27 }, (_, index) => index + 1));
    const runtime = runtimeSources.map((file) => readFileSync(join(import.meta.dirname, "../../../", file), "utf8")).join("\n");
    expect((runtime.match(/INSERT INTO scheduler_reservations/g) ?? []).length).toBe(3);
    expect(readFileSync(join(import.meta.dirname, "../../../src/platform/database/migrations/013_remove_legacy_scheduler_locks.sql"), "utf8")).toContain("scheduler_reservations");
    expect(readFileSync(join(import.meta.dirname, "../../../src/platform/database/migrations/014_migrate_legacy_scheduler_authority.sql"), "utf8")).toContain("scheduler_reservations");
    expect(readdirSync(join(import.meta.dirname, "../../../src/platform/database/migrations")).some((file) => file.startsWith("028_"))).toBe(false);
  });
});
