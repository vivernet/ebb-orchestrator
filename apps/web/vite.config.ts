import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function e2eBackendOrigin() {
  const value = process.env.EBB_E2E_BACKEND_URL;
  if (!value || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value)) {
    throw new Error("E2E requires a validated launcher-provided loopback backend origin");
  }
  const port = Number(value.slice(value.lastIndexOf(":") + 1));
  if (port > 65535) throw new Error("E2E backend port is outside the TCP range");
  return value;
}

export default defineConfig(({ mode }) => {
  const backend = mode === "e2e" ? e2eBackendOrigin() : "http://127.0.0.1:3000";
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: backend,
          changeOrigin: true,
          headers: { Origin: backend },
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts"],
      exclude: ["test/e2e/**", "node_modules/**"],
      resolve: { extensions: [".tsx", ".ts", ".js", ".jsx"] },
    },
  };
});
