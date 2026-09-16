/**
 * Orchestrator module - coordinates Workflow, Scheduler, and Runtime.
 *
 * Provides:
 * - Event subscription and dispatch
 * - Runtime lifecycle management
 * - Integration with workflow transitions
 */

import type { Database } from "../../platform/database/database.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { EventBus } from "../../platform/events/event-bus.js";
import { EventDispatcher } from "../../platform/events/event-dispatcher.js";
import { RuntimeEventHandlers } from "./run-event-handlers.js";

/**
 * Orchestrator for runtime events.
 *
 * Consumes:
 * - AgentRunRequested: Starts runtime workflow
 * - ApprovalApproved (FINAL_MERGE): Advances workflow stage
 *
 * Produces:
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
  ) {
    this.eventHandlers = new RuntimeEventHandlers(db, workflowEngine);
  }

  /**
   * Initialize event subscriptions.
   */
  initialize(): void {
    // Subscribe to AgentRunRequested events
    this.bus.subscribe(
      "AgentRunRequested",
      "runtime-orchestrator",
      (event: { readonly type: string; readonly aggregateId: string | undefined; readonly payload: Record<string, unknown> }) => {
        this.eventHandlers.handleAgentRunRequested(event);
      },
    );

    // Subscribe to ApprovalApproved events
    this.bus.subscribe(
      "ApprovalApproved",
      "runtime-orchestrator",
      (event: { readonly type: string; readonly aggregateId: string | undefined; readonly payload: Record<string, unknown> }) => {
        this.eventHandlers.handleApprovalApproved(event);
      },
    );
  }

  /**
   * Dispatch pending events with idempotency.
   */
  async dispatchPendingEvents(limit: number): Promise<number> {
    return this.dispatcher.dispatchBatch(limit);
  }

  /**
   * Handle runtime completion from external sources.
   */
  handleRuntimeCompletion(
    taskId: string,
    outcome: { success: boolean; exitCode: number; output: string },
  ): void {
    this.eventHandlers.handleRuntimeCompletion(taskId, outcome);
  }

  /**
   * Handle run interruption.
   */
  handleRunInterrupted(taskId: string): void {
    this.eventHandlers.handleRunInterrupted(taskId);
  }
}

/**
 * Register the runtime orchestrator with the event bus.
 */
export function registerRuntimeOrchestrator(
  db: Database,
  workflowEngine: WorkflowEngine,
  bus: EventBus,
  dispatcher: EventDispatcher,
): RuntimeOrchestrator {
  const orchestrator = new RuntimeOrchestrator(
    db,
    workflowEngine,
    bus,
    dispatcher,
  );
  orchestrator.initialize();
  return orchestrator;
}
