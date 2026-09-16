import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests sequentially to avoid parallel file locking issues
    pool: "forks",
    // Test timeout
    testTimeout: 60000,
    // Only run one test file at a time
    fileParallelism: false,
  },
});
