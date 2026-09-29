#!/usr/bin/env node
import process from 'node:process';

process.on('message', (message) => {
  if (message === 'ebb-v1-crash-recovery:shutdown') process.emit('SIGTERM');
});

await import('../../../dist/main.js');
