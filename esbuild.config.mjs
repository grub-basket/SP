import esbuild from "esbuild";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  // 0.267.9: keep function names even when minified. The debug trace records
  // WHICH code asked for a render, and in a minified build that came back as
  // "i < Us" — present, useless. A trace whose one diagnostic field is
  // unreadable costs a whole round trip with the user to discover that.
  keepNames: true,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
