import eslint from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "apps/server/src/**/*.{ts,tsx}",
      "apps/web/src/**/*.{ts,tsx}",
      "packages/*/src/**/*.{ts,tsx}",
    ],
    plugins: { jsdoc },
    settings: {
      jsdoc: { mode: "typescript" },
    },
    rules: {
      "jsdoc/check-param-names": "warn",
      "jsdoc/check-tag-names": "warn",
      "jsdoc/check-syntax": "warn",
      "jsdoc/require-description": ["warn", { descriptionStyle: "body" }],
      "jsdoc/require-jsdoc": [
        "warn",
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true,
          },
        },
      ],
    },
  },
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
