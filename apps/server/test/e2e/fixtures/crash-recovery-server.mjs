#!/usr/bin/env node
import process from 'node:process';

if (process.argv.includes('--observe-task5c-first-read')) {
  const { HermesStreamSessionObserver } = await import('../../../dist/modules/runtime/hermes/hermes-stream-session-observer.js');
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
