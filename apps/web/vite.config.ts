import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: mode === 'e2e' ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:3000',
        changeOrigin: true,
        headers: { Origin: mode === 'e2e' ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:3000' },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    resolve: {
      extensions: [".tsx", ".ts", ".js", ".jsx"],
    },
  },
}));
