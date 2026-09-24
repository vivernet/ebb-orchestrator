import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "vmThreads",
    testTimeout: 60000,
    isolate: false,
  },
});
