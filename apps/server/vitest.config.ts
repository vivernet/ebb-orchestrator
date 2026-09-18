import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests with vmThreads for isolation
    pool: "vmThreads",
    // Test timeout
    testTimeout: 60000,
    // Disable isolation to avoid parallel file locking issues
    isolate: false,
  },
});
