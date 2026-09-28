import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Race suites запускают дочерние процессы; один worker исключает ENOMEM и ложные readiness timeouts на Windows.
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 60000,
    isolate: false,
  },
});
