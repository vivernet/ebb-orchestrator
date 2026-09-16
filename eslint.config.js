import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/server/test/e2e/fixtures/health-service/src/server.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        require: "readonly",
        module: "readonly",
        console: "readonly",
      },
    },
  },
);
