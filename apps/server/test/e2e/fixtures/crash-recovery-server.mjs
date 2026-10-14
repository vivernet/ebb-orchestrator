#!/usr/bin/env node
import process from 'node:process';

if (process.argv.includes('--observe-task5c-first-read')) {
  const { HermesStreamSessionObserver } = await import('../../../dist/modules/runtime/hermes/hermes-stream-session-observer.js');
  const { RunService } = await import('../../../dist/modules/runtime/run-service.js');
  const { SchedulerService } = await import('../../../dist/modules/scheduler/scheduler-service.js');
  const { SchedulerRunRequestWorker } = await import('../../../dist/modules/scheduler/scheduler-run-request-worker.js');
  const { classifyTask5cPreflightError } = await import('./task5c-safe-diagnostic.mjs');
  const stages = new Set([
    'QUEUE_NOT_READY',
    'QUEUE_DRAIN_STARTED', 'QUEUE_DRAIN_COMPLETED', 'QUEUE_DRAIN_FAILED',
    'QUEUE_REQUEST_SELECTED', 'QUEUE_EMPTY',
    'HERMES_PREFLIGHT_STARTED', 'HERMES_PREFLIGHT_COMPLETED', 'HERMES_PREFLIGHT_FAILED',
    'RUN_CONTEXT_STARTED', 'RUN_CONTEXT_COMPLETED', 'RUN_CONTEXT_FAILED',
    'RUN_TRANSACTION_PREPARE_STARTED', 'RUN_TRANSACTION_PREPARE_COMPLETED', 'RUN_TRANSACTION_PREPARE_FAILED',
    'RUN_REQUEST_DISPATCH_STARTED', 'RUN_REQUEST_DISPATCH_COMPLETED', 'RUN_REQUEST_DISPATCH_NOT_SELECTED', 'RUN_REQUEST_DISPATCH_FAILED',
    'HERMES_PREFLIGHT_COMMIT_STARTED', 'HERMES_PREFLIGHT_COMMIT_COMPLETED', 'HERMES_PREFLIGHT_COMMIT_FAILED',
  ]);
  const reportStage = (stage) => {
    if (stages.has(stage)) process.send?.({ type: 'task5c:stage', stage });
  };
  const reportPreflightCode = (error) => {
    const code = classifyTask5cPreflightError(error);
    process.send?.({ type: 'task5c:preflight-code', code });
  };

  const workerPrototype = SchedulerRunRequestWorker.prototype;
  const nudge = workerPrototype.nudge;
  workerPrototype.nudge = function (...args) {
    if (!this.dependencies.isReady()) reportStage('QUEUE_NOT_READY');
    return nudge.apply(this, args);
  };
  const tick = workerPrototype.tick;
  workerPrototype.tick = function (...args) {
    if (!this.dependencies.isReady()) reportStage('QUEUE_NOT_READY');
    return tick.apply(this, args);
  };
  const drain = workerPrototype.drain;
  workerPrototype.drain = async function (...args) {
    reportStage('QUEUE_DRAIN_STARTED');
    try {
      const result = await drain.apply(this, args);
      reportStage('QUEUE_DRAIN_COMPLETED');
      return result;
    } catch (error) {
      reportStage('QUEUE_DRAIN_FAILED');
      throw error;
    }
  };

  const schedulerPrototype = SchedulerService.prototype;
  const nextRunRequest = schedulerPrototype.nextRunRequest;
  schedulerPrototype.nextRunRequest = function (...args) {
    const result = nextRunRequest.apply(this, args);
    reportStage(result ? 'QUEUE_REQUEST_SELECTED' : 'QUEUE_EMPTY');
    return result;
  };
  const dispatchRunRequest = schedulerPrototype.dispatchRunRequest;
  schedulerPrototype.dispatchRunRequest = function (...args) {
    reportStage('RUN_REQUEST_DISPATCH_STARTED');
    try {
      const result = dispatchRunRequest.apply(this, args);
      reportStage(result ? 'RUN_REQUEST_DISPATCH_COMPLETED' : 'RUN_REQUEST_DISPATCH_NOT_SELECTED');
      return result;
    } catch (error) {
      reportStage('RUN_REQUEST_DISPATCH_FAILED');
      throw error;
    }
  };

  const runPrototype = RunService.prototype;
  const beginHermesRunPreflight = runPrototype.beginHermesRunPreflight;
  runPrototype.beginHermesRunPreflight = async function (...args) {
    reportStage('HERMES_PREFLIGHT_STARTED');
    try {
      const result = await beginHermesRunPreflight.apply(this, args);
      const commit = result.commit;
      result.commit = async function (...commitArgs) {
        reportStage('HERMES_PREFLIGHT_COMMIT_STARTED');
        try {
          const committed = await commit.apply(this, commitArgs);
          reportStage('HERMES_PREFLIGHT_COMMIT_COMPLETED');
          return committed;
        } catch (error) {
          reportStage('HERMES_PREFLIGHT_COMMIT_FAILED');
          throw error;
        }
      };
      reportStage('HERMES_PREFLIGHT_COMPLETED');
      return result;
    } catch (error) {
      reportStage('HERMES_PREFLIGHT_FAILED');
      reportPreflightCode(error);
      throw error;
    }
  };
  const prepareRunContext = runPrototype.prepareRunContext;
  runPrototype.prepareRunContext = function (...args) {
    reportStage('RUN_CONTEXT_STARTED');
    try {
      const result = prepareRunContext.apply(this, args);
      reportStage('RUN_CONTEXT_COMPLETED');
      return result;
    } catch (error) {
      reportStage('RUN_CONTEXT_FAILED');
      throw error;
    }
  };
  const prepareRunInTransaction = runPrototype.prepareRunInTransaction;
  runPrototype.prepareRunInTransaction = function (...args) {
    reportStage('RUN_TRANSACTION_PREPARE_STARTED');
    try {
      const result = prepareRunInTransaction.apply(this, args);
      reportStage('RUN_TRANSACTION_PREPARE_COMPLETED');
      return result;
    } catch (error) {
      reportStage('RUN_TRANSACTION_PREPARE_FAILED');
      throw error;
    }
  };

  const sessionIds = new WeakMap();
  const push = HermesStreamSessionObserver.prototype.push;
  HermesStreamSessionObserver.prototype.push = function (chunk) {
    const update = push.call(this, chunk);
    if (update.status === 'captured' && update.projection) sessionIds.set(this, update.projection.sessionId);
    const sessionId = sessionIds.get(this);
    const counts = this.toolEventCountsSnapshot;
    if (sessionId && counts['workspace.read'].successes > 0 && !this.task5cFirstReadReported) {
      this.task5cFirstReadReported = true;
      process.send?.({ type: 'task5c:first-read', sessionId });
    }
    return update;
  };
}

process.on('message', (message) => {
  if (message === 'ebb-v1-crash-recovery:shutdown') process.emit('SIGTERM');
});

await import('../../../dist/main.js');
