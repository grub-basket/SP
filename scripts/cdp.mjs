// Minimal CDP driver for the running Obsidian. Node 18+ globals (fetch/WebSocket).
// Usage: node scripts/cdp.mjs '<js expression returning a JSON-serializable value>'
// The expression runs with `app` in scope (async IIFE; you may await).

const expr = process.argv[2];
if (!expr) { console.error("need an expression"); process.exit(1); }

const targets = await (await fetch("http://localhost:9222/json")).json();
const page = targets.find((t) => t.type === "page" && /obsidian\.md|app:\/\/obsidian/.test(t.url))
  || targets.find((t) => t.type === "page" && t.url !== "about:blank")
  || targets[0];
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise((res) => { ws.onopen = res; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};

const wrapped = `(async () => { try { const __r = await (async () => { ${expr} })(); return JSON.stringify(__r); } catch (e) { return JSON.stringify({ __error: String(e && e.stack || e) }); } })()`;
const r = await send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true });
console.log(r.result?.value ?? JSON.stringify(r));
ws.close();
process.exit(0);
