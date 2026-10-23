import type { Database } from "../../platform/database/database.js";
import type { RunService } from "../runtime/run-service.js";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import { prepareTaskRunOptions, prepareTaskIntegrationOptions } from "../runtime/task-run-context.js";
import { RunProviderSelectionError } from "../runtime/providers/run-provider-selection.js";
import type { IntegrationService, IntegrationAttempt } from "../git/integration-service.js";
import type { SchedulerService } from "./scheduler-service.js";
import type { EventBus } from "../../platform/events/event-bus.js";
import { RecoveryService } from "../recovery/recovery-service.js";
import { DEFAULT_POLICY } from "../recovery/recovery-types.js";

const INTEGRITY_FAILURES = new Map([
  ["RUN_REQUEST_TASK_NOT_FOUND", "RUN_REQUEST_TASK_NOT_FOUND"],
  ["TASK_MANAGED_WORKSPACE_UNAVAILABLE", "RUN_REQUEST_WORKSPACE_UNAVAILABLE"],
  ["TASK_REVIEW_BASE_UNAVAILABLE", "RUN_REQUEST_REVIEW_BASE_UNAVAILABLE"],
  ["TASK_INTEGRATION_REQUIRES_PREPARED_ATTEMPT", "RUN_REQUEST_INTEGRATION_UNAVAILABLE"],
  ["PREPARED_CONTEXT_SUBJECT_MISMATCH", "RUN_REQUEST_CONTEXT_INVALID"],
  ["PREPARED_CONTEXT_ROLE_MISMATCH", "RUN_REQUEST_CONTEXT_INVALID"],
]);

/** READY-gated durable queue consumer; события ускоряют проход, периодический tick восстанавливает пропущенные nudges.
 * Один instance coalesce-ит concurrent ticks; отдельные workers сериализуются в Scheduler write transaction.
 */
export class SchedulerRunRequestWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;
  private wakeRequested = false;
  private stopped = true;
  private unobserve: (() => void) | undefined;
  constructor(private readonly dependencies: {
    db: Database; scheduler: SchedulerService; runs: RunService; workflow: WorkflowEngine;
    isReady: () => boolean; eventBus?: EventBus;
    integrationFactory?: (runId: string) => IntegrationService;
  }) { if (dependencies.integrationFactory) dependencies.runs.setTaskIntegrationFactory(dependencies.integrationFactory); }

  /** Подключает nudges; startup READY scan вызывается composition после публикации READY. */
  async start(): Promise<void> {
    this.stopped = false;
    this.dependencies.scheduler.setRunRequestNudge(() => this.nudge());
    this.unobserve = this.dependencies.eventBus?.observe(() => this.nudge());
    this.timer = setInterval(() => this.nudge(), 5_000);
    this.timer.unref?.();
    this.nudge();
  }

  /** Снимает triggers и дожидается producer transaction/preflight перед закрытием базы. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unobserve?.();
    this.unobserve = undefined;
    this.dependencies.scheduler.setRunRequestNudge(undefined);
    await this.draining;
  }

  /** Не dispatch-ит в RECOVERING; wake сохраняется до следующего READY scan/tick. */
  nudge(): void {
    this.wakeRequested = true;
    if (this.stopped || !this.dependencies.isReady()) return;
    void this.tick().catch(() => { /* durable PENDING повторяется на safety tick */ });
  }

  /** Проход доступен production composition и acceptance; каждая выборка предваряется reconcile. */
  tick(): Promise<void> {
    this.wakeRequested = true;
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const { scheduler, runs, workflow, db, isReady } = this.dependencies;
    while (this.wakeRequested && isReady()) {
      this.wakeRequested = false;
      new RecoveryService(db, DEFAULT_POLICY).recoverTaskRunRequests(scheduler, workflow);
      scheduler.reconcile();
      for (;;) {
        if (!isReady()) return;
        const request = scheduler.nextRunRequest();
        if (!request) break;
        let integration: { service: IntegrationService; attempt: IntegrationAttempt } | undefined;
        let committed = false;
        try {
          let options;
          if ((request.originType === "TASK_STAGE" || request.originType === "TASK_RECOVERY") && request.role === "integration" && this.dependencies.integrationFactory) {
            const runId = crypto.randomUUID();
            const service = this.dependencies.integrationFactory(runId);
            const prepared = await prepareTaskIntegrationOptions(db, request, runId, service);
            options = prepared.options;
            integration = { service, attempt: prepared.attempt };
          } else options = await prepareTaskRunOptions(db, request);
          const sourceContract = db.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id=$id", { id: request.taskId })?.contract_json;
          const preflight = await runs.beginHermesRunPreflight(options);
          try {
            const prepared = runs.prepareRunContext(preflight.options);
            const run = scheduler.dispatchRunRequest(request.id, workflow, (tx, current) => {
              if (current.taskId !== request.taskId || current.role !== request.role || current.model !== request.model) throw new Error("RUN_REQUEST_PREPARED_IDENTITY_MISMATCH");
              if (tx.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id=$id", { id: request.taskId })?.contract_json !== sourceContract) throw new Error("PREPARED_CONTEXT_CHANGED_WITHIN_TRANSACTION");
              return runs.prepareRunInTransaction(tx, { ...preflight.options, prompt: prepared.finalPrompt }, prepared);
            }, isReady);
            if (run) { committed = true; await preflight.commit(); }
            else { await preflight.cleanup(); this.wakeRequested = true; break; }
          } finally { await preflight.cleanup(); }
        } catch (error) {
          const code = error instanceof Error ? INTEGRITY_FAILURES.get(error.message) : undefined;
          if (code) { scheduler.failRunRequest(request.id, code); continue; }
          // Fail-closed ошибки валидации выбора провайдера терминальны: повторный
          // проход не изменит результат до исправления настроек/запроса.
          if (error instanceof RunProviderSelectionError) { scheduler.failRunRequest(request.id, error.code); continue; }
          // Snapshot/order changes and infrastructure faults keep PENDING; avoid a tight retry loop.
          break;
        } finally {
          if (integration && !committed) await integration.service.cleanupIntegration(integration.attempt);
        }
      }
    }
  }
}
