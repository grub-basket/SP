// ESLint flat config — surfaces the rules the Obsidian community-plugin review
// bot actually acts on (eslint-plugin-obsidianmd). Treat a clean
// `pnpm run lint` as a pre-publish gate so a store rejection is caught here.
//
// IMPORTANT: the `obsidianmd/recommended` preset also pulls in
// typescript-eslint's *type-checked* layer (no-unsafe-*, no-explicit-any, …),
// which fires thousands of times on this codebase's pre-existing `as any`
// usage. The store does NOT gate on those — historically only the obsidianmd/*
// rules block publishing. So we turn off the type-aware @typescript-eslint
// noise, leaving the obsidianmd/* rules (the real gate) front and centre.
//
// Order matters: `disableTypeChecked` also clears parserOptions.project, so the
// parser+project block is re-asserted AFTER it — several obsidianmd rules
// (no-plugin-as-component, …) require type information to run.
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: ["main.js", "node_modules/**", "dist/**", "*.mjs"],
  },
  ...obsidianmd.configs.recommended,
  tseslint.configs.disableTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // Stylistic base rules the store ignores; off so obsidianmd findings
      // aren't buried.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
    },
  },
];
