/** 0.569.0 — notifications open things through ONE router, never by hand.
 *
 *  A notification that takes the user somewhere declares it as data:
 *
 *      plugin.notifications.show({ …, open: { folder, id?, button?, body? } })
 *
 *  and the NotificationService sends the click to the plugin's
 *  `openNotificationTarget`, which never changes what an existing tab shows
 *  (each click gets its own fresh tab; a tab already showing exactly that
 *  note is just brought forward). The rule exists because hand-written
 *  handlers kept reaching for whatever "open" helper was nearby —
 *  revealNoteByRef / revealNoteInStashpad / openFolderInStashpad reuse the tab
 *  already on that folder and NAVIGATE it, and view.navigateTo() steers the
 *  tab in place — so clicking a teammate's toast overwrote the tab the user
 *  was working in. Every new toast was a fresh chance to reintroduce that.
 *
 *  What this check reads (with the TypeScript parser, so a paren or slash
 *  inside a message string can't throw it off):
 *    - every notification call: `….notifications.show(…)`, `notify(…)`;
 *    - every `actions.push(…)` (toast buttons built up in an array);
 *    - every function or variable typed as NotificationAction / NotificationOpen
 *      (helpers that build toast buttons away from the show() call).
 *  It fails if one of them calls a tab-opening / tab-navigating helper. If a
 *  handler genuinely must (e.g. an Undo that reopens a restored folder in a
 *  NEW tab), say so inside it:
 *
 *      // notif-open: ok — <why>
 *
 *  Same spirit as check-tab-openers.mjs: make forgetting impossible and opting
 *  out deliberate.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import tsModule from "typescript";

const ts = tsModule.default ?? tsModule;
const SRC = "src";
const FORBIDDEN = new Set([
  "revealNoteByRef", "revealNoteInStashpad", "revealRowByRef", "openFolderInStashpad",
  "activateViewForFolder", "activateView", "openDeepLinkTarget", "navigateLeafTo",
  "navigateTo", "getLeaf", "setViewState", "openFile", "openLinkText",
  "switchToFolderAndFocus", "setFolderOverride", "handleDeepLink",
]);
const OPTOUT = /notif-open:\s*ok/;
const NOTIF_TYPE = /\bNotification(Action|Open)\b/;

async function tsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const calleeName = (call) => {
  const ex = call.expression;
  if (ts.isIdentifier(ex)) return ex.text;
  if (ts.isPropertyAccessExpression(ex)) return ex.name.text;
  return "";
};

/** The node a notification "scope" covers, or null if `node` isn't one. */
function scopeOf(node, sf) {
  if (ts.isCallExpression(node)) {
    const ex = node.expression;
    if (ts.isIdentifier(ex) && ex.text === "notify") return node;
    if (ts.isPropertyAccessExpression(ex)) {
      const recv = ex.expression.getText(sf);
      if (ex.name.text === "show" && /notifications$/.test(recv)) return node;
      if (ex.name.text === "push" && /\bactions$/.test(recv)) return node;
    }
    return null;
  }
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && node.type && NOTIF_TYPE.test(node.type.getText(sf)) && node.body) return node.body;
  if (ts.isVariableDeclaration(node) && node.type && NOTIF_TYPE.test(node.type.getText(sf)) && node.initializer) return node.initializer;
  return null;
}

const problems = new Map(); // "path:line" → message (nested scopes report once)
let scopes = 0;
for (const path of await tsFiles(SRC)) {
  // The service itself is the one place allowed to wire clicks.
  if (path.endsWith("notifications.ts")) continue;
  const text = await readFile(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const scope = scopeOf(node, sf);
    if (scope) {
      scopes++;
      const raw = text.slice(scope.getStart(sf), scope.end);
      if (!OPTOUT.test(raw)) {
        const hunt = (n) => {
          if (ts.isCallExpression(n) && FORBIDDEN.has(calleeName(n))) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
            problems.set(`${path}:${line + 1}`, `  ${path}:${line + 1}  calls ${calleeName(n)}() from a notification handler`);
          }
          ts.forEachChild(n, hunt);
        };
        // Arguments only for a call scope: the callee itself (e.g. the
        // `this.plugin.notifications` chain) is never the problem.
        if (ts.isCallExpression(scope)) scope.arguments.forEach(hunt);
        else hunt(scope);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (problems.size) {
  console.error(`\nnotification-open check FAILED — ${problems.size} notification handler(s) open or steer a tab by hand:\n`);
  console.error([...problems.values()].join("\n"));
  console.error(`\nDeclare the target instead: show({ …, open: { folder, id?, button?, body? } }).`);
  console.error(`The service routes it to openNotificationTarget, which never changes what an`);
  console.error(`existing tab shows. If a handler truly must open/steer a tab itself, mark it`);
  console.error(`inside the handler: // notif-open: ok — <why>\n`);
  process.exit(1);
}
console.log(`notification-open check\n  ✓ ${scopes} notification calls/builders; none open or steer a tab by hand (they use \`open:\`)`);
