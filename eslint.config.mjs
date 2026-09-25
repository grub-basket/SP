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
      // 0.485.0 — local guard, not a store rule. `getLeavesOfType()` returns
      // leaves in TAB order, so `[0]` and `.find()` mean "the LEFTMOST tab",
      // never "the tab the user is looking at". That mistake shipped three
      // times in features written years apart (0.68.1 sidebar buttons, 0.484.0
      // drafts loading into the wrong tab, 0.484.1 reveal + deep-link
      // navigation), each time reported as "the button does nothing" because
      // the work landed in a tab that was off-screen.
      //
      // Scoped to STASHPAD_VIEW_TYPE ON PURPOSE. Other view types are not
      // ambiguous the same way: "file-explorer" has exactly one leaf (so [0] is
      // correct and idiomatic), and the aggregate / kanban / panels views find
      // by a DISTINGUISHING key (mode, folder, panel) where at most one tab can
      // match. Only plain Stashpad tabs are routinely duplicated on the same
      // folder, which is what makes "which one" a real question.
      //
      // Iterating ALL leaves stays fine and is not flagged — this only catches
      // picking ONE leaf out of the list, which is the operation that has to
      // care about recency. Use the helpers in `src/leaf-lookup.ts`.
      "no-restricted-syntax": ["error",
        {
          selector: 'MemberExpression[computed=true][object.callee.property.name="getLeavesOfType"][object.arguments.0.name="STASHPAD_VIEW_TYPE"]',
          message: "getLeavesOfType() is in TAB order \u2014 indexing it picks the LEFTMOST tab, not the focused one. Use preferredStashpadLeafOnFolder(app, plugin, folder) from src/leaf-lookup.ts (or preferredStashpadLeaf for any folder).",
        },
        {
          selector: 'CallExpression[callee.property.name="find"][callee.object.callee.property.name="getLeavesOfType"][callee.object.arguments.0.name="STASHPAD_VIEW_TYPE"]',
          message: "getLeavesOfType().find() returns the LEFTMOST matching tab, not the focused one. Use preferredStashpadLeafOnFolder(app, plugin, folder) from src/leaf-lookup.ts \u2014 or anyStashpadLeafOnFolder() if order genuinely cannot matter.",
        },
        {
          selector: 'CallExpression[callee.property.name="find"][callee.object.callee.object.callee.property.name="getLeavesOfType"][callee.object.callee.object.arguments.0.name="STASHPAD_VIEW_TYPE"]',
          message: "getLeavesOfType().map(...).find(...) returns the LEFTMOST match, not the focused one. Use preferredStashpadLeafOnFolder(app, plugin, folder) from src/leaf-lookup.ts \u2014 or anyStashpadLeafOnFolder() if order genuinely cannot matter.",
        },
      ],
    },
  },
  {
    // src/leaf-lookup.ts is the sanctioned home for the raw single-leaf idiom —
    // the rule above exists to funnel every caller through it, so it must not
    // apply to the funnel itself. Turned off for that ONE file, as a trailing
    // override so the parser + project settings above still apply to it (the
    // type-aware obsidianmd rules need them; excluding the file from that whole
    // block instead breaks them with "you have used a rule which requires type
    // information"). Scoped this way rather than with an eslint-disable comment
    // because this repo keeps ZERO eslint-disable in src/ — the store review
    // reads those as suppressed findings.
    files: ["src/leaf-lookup.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
];
