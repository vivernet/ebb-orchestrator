#!/usr/bin/env node

const SHUTDOWN_MESSAGE = "ebb-local-user-stdin-smoke:shutdown";

process.on("message", (message) => {
  if (message === SHUTDOWN_MESSAGE) process.emit("SIGTERM");
});

await import("../apps/server/dist/main.js");
