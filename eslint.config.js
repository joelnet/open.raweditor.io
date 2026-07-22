import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-plugin-prettier/recommended";

export default [
  {
    ignores: ["node_modules/", "dist/", "src/tone/skyseg/", "src/decode/jxl/"],
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
  {
    // Copied verbatim into the build and imported by the generated service
    // worker, so it runs in worker scope rather than the bundle's.
    files: ["public/*.js"],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["scripts/**"],
    languageOptions: {
      globals: {
        ...globals.bunBuiltin,
      },
    },
  },
];
