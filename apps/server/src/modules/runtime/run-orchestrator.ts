/**
 * Orchestrator module - coordinates workflow, Scheduler, и runtime.
 *
 * Предоставляет:
 * - Event subscription and dispatch
 * - Runtime lifecycle management
 * - Integration with workflow transitions
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { EventBus } from "../../platform/events/event-bus.js";
import { EventDispatcher } from "../../platform/events/event-dispatcher.js";
import { RuntimeEventHandlers } from "./run-event-handlers.js";
import { SchedulerService } from "../scheduler/scheduler-service.js";
import { RunService } from "./run-service.js";

/**
 * Orchestrator для runtime события.
 *
 * Использует:
 * - AgentRunRequested: Starts runtime workflow
 * - ApprovalApproved (FINAL_MERGE): Advances workflow stage
 *
 * Формирует:
 * - AgentRunStarted
 * - AgentRunCompleted
 * - AgentRunFailed
 * - AgentRunInterrupted
 * - TaskStateChanged (via workflow engine)
 */
export class RuntimeOrchestrator {
  private readonly eventHandlers: RuntimeEventHandlers;

  constructor(
    private readonly db: Database,
    private readonly workflowEngine: WorkflowEngine,
    private readonly bus: EventBus,
    private readonly dispatcher: EventDispatcher,
    scheduler: SchedulerService,
    runService?: RunService,
  ) {
    this.eventHandlers = new RuntimeEventHandlers(db, workflowEngine, scheduler, runService);
  }

  /**
   * Initialize событие subscriptions.
   */
  initialize(): void {
    // Subscribe to AgentRunRequested события
    this.bus.subscribe(
      "AgentRunRequested",
      "runtime-orchestrator",
      (event: { readonly type: string; readonly aggregateId: string | undefined; readonly payload: Record<string, unknown> }) => {
        return this.eventHandlers.handleAgentRunRequested(event);
      },
    );

    // Subscribe to ApprovalApproved события
    this.bus.subscribe(
      "ApprovalApproved",
      "runtime-orchestrator",
      (event: { readonly type: string; readonly aggregateId: string | undefined; readonly payload: Record<string, unknown> }) => {
        this.eventHandlers.handleApprovalApproved(event);
      },
    );
  }

  /**
   * Dispatch ожидающий события с idempotency.
   */
  async dispatchPendingEvents(limit: number): Promise<number> {
    return this.dispatcher.dispatchBatch(limit);
  }

  /**
   * Обрабатывает runtime completion from external sources.
   */
  handleRuntimeCompletion(
    runId: string,
    outcome: import("./run-types.js").RunOutcome,
  ): void {
    this.eventHandlers.handleRuntimeCompletion(runId, outcome);
  }

  /**
   * Обрабатывает run interruption.
   */
  handleRunInterrupted(taskId: string): void {
    this.eventHandlers.handleRunInterrupted(taskId);
  }
}

/**
 * Register Объект runtime orchestrator с Объект событие bus.
 */
export function registerRuntimeOrchestrator(
  db: Database,
  workflowEngine: WorkflowEngine,
  bus: EventBus,
  dispatcher: EventDispatcher,
  scheduler: SchedulerService,
  runService?: RunService,
): RuntimeOrchestrator {
  const orchestrator = new RuntimeOrchestrator(
    db,
    workflowEngine,
    bus,
    dispatcher,
    scheduler,
    runService,
  );
  orchestrator.initialize();
  return orchestrator;
}
