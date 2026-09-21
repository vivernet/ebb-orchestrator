import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
  // Запускаем тесты с vmThreads для изоляции.
    pool: "vmThreads",
  // Тайм-аут теста.
    testTimeout: 60000,
  // Отключаем изоляцию, чтобы избежать параллельных блокировок файлов.
    isolate: false,
  },
});
