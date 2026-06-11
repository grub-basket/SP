/* Reset a Claude Dev Vault TEST folder (Alpha/Beta) to its canonical state.
 * Driven by scripts/reset-test-folder (sets window.__resetFolder first).
 * HARD-REFUSES the "Stashpad" folder + "_deleted" (real data / reserved). */
(async () => {
  const F = window.__resetFolder;
  if (app.vault.getName() !== "Claude Dev Vault") return "REFUSED: wrong vault (" + app.vault.getName() + ")";
  if (F === "Stashpad" || F === "_deleted" || !/^(Alpha|Beta)$/.test(F)) return "REFUSED: " + F + " (only Alpha/Beta)";
  const ad = app.vault.adapter;
  const pfx = F.toLowerCase(); // alpha | beta
  // detach views on F so the rebuild is clean
  for (const l of app.workspace.getLeavesOfType("stashpad-view")) {
    const ff = l.isDeferred ? l.getViewState()?.state?.folderOverride : l.view?.noteFolder;
    if (ff === F) l.detach();
  }
  // wipe every note in F EXCEPT the Home note
  for (const f of app.vault.getMarkdownFiles().filter((f) => (f.parent?.path || "") === F && f.basename !== `Home-${F}`)) await app.vault.delete(f);
  // clear encryption artifacts (.stashenc blobs + .stashmeta sidecars) + registry entries
  try { const li = await ad.list(F); for (const path of li.files) if (/\.(stashenc|stashmeta)$/.test(path)) await ad.remove(path); } catch (e) {}
  const p = app.plugins.plugins["stashpad"];
  if (p?.settings?.lockedSubtrees) {
    const before = p.settings.lockedSubtrees.length;
    p.settings.lockedSubtrees = p.settings.lockedSubtrees.filter((e) => (e.folder || "").replace(/\/+$/, "") !== F);
    if (p.settings.lockedSubtrees.length !== before) await p.saveSettings();
  }
  if (!(await ad.exists(F))) await ad.mkdir(F);
  if (!app.vault.getAbstractFileByPath(`${F}/Home-${F}.md`)) {
    await app.vault.create(`${F}/Home-${F}.md`, `---\nid: __root__\nparent: __root__\ncreated: 2026-06-08T12:00:00\nattachments: []\n---\n# ${F} Home\n`);
  }
  const mk = (file, id, parent, created, body) =>
    app.vault.create(`${F}/${file}.md`, `---\nid: ${id}\nparent: ${parent}\ncreated: ${created}\nattachments: []\nparentLink: "[[${F}/Home-${F}]]"\n---\n${body}\n`);
  // created times ascending by number → correct order without an order store
  await mk("note-1", `${pfx}n1`, "__root__", "2026-06-08T12:01:00", `Top-level note 1 in ${F}.`);
  await mk("note-2", `${pfx}n2`, "__root__", "2026-06-08T12:02:00", `Top-level note 2 in ${F}.`);
  await mk("note-3", `${pfx}n3`, "__root__", "2026-06-08T12:03:00", `Top-level note 3 in ${F}.`);
  await mk("note-4", `${pfx}n4`, "__root__", "2026-06-08T12:04:00", `Top-level note 4 in ${F}.`);
  await mk("note-5", `${pfx}n5`, "__root__", "2026-06-08T12:05:00", `Top-level note 5 in ${F}.`);
  await mk("child-a", `${pfx}c1`, `${pfx}n1`, "2026-06-08T12:06:00", `Child A under note 1 of ${F}.`);
  await mk("child-b", `${pfx}c2`, `${pfx}n1`, "2026-06-08T12:07:00", `Child B under note 1 of ${F}.`);
  await mk("grand", `${pfx}g1`, `${pfx}c1`, "2026-06-08T12:08:00", `Grandchild under child A of ${F}.`);
  await new Promise((r) => setTimeout(r, 800));
  const v = app.workspace.getLeavesOfType("stashpad-view").find((l) => !l.isDeferred && l.view?.noteFolder === F)?.view;
  if (v) { v.tree.rebuild(F); v.render?.(); }
  return JSON.stringify({ reset: F, files: app.vault.getMarkdownFiles().filter((f) => (f.parent?.path || "") === F).map((f) => f.basename).sort() });
})()
