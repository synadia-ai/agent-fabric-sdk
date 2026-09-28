import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "eslint.config.mjs",
      "*.config.ts",
      "*.config.mts",
      // A stand-in for the `sp` CLI, run as a program by the tests.
      "test/harness/*.mjs",
      // Standalone JavaScript qualification runner; no TypeScript project context.
      "scripts/run-native-tests.mjs",
      "scripts/measure-native-spool.mjs",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  prettier,
);
