import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-plugin-prettier/recommended";

export default [
  {
    ignores: ["node_modules/", "dist/"],
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
  },
];
