#!/usr/bin/env node

process.on("message", (message) => {
  if (message === "ebb-plan01-process-recovery:shutdown") process.emit("SIGTERM");
});

await import("../apps/server/dist/main.js");
