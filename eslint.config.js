import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "test-results/",
      "playwright-report/",
      "blob-report/",
      "playwright/",
    ],
  },
  js.configs.recommended,
  {
    // Extension files run as classic scripts: the popup via <script> and the
    // content script via chrome.scripting.executeScript.
    files: ["extension/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ["tools/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      sourceType: "module",
      globals: globals.node,
    },
  },
];
