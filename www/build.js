// Builds the static site into dist/: the page with its scripts bundled, the
// Rust wasm package that wasm-pack built into ../pkg, the language model's
// weights and the tokenizer.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "dist");
const copy = (from, to) => fs.cpSync(path.join(__dirname, from), path.join(dist, to), { recursive: true });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "pkg"), { recursive: true });

for (const file of [
  "index.html",
  "favicon.ico",
  "favicon-32x32.png",
  "favicon-16x16.png",
  "apple-touch-icon.png",
  "model",
]) {
  copy(file, file);
}

for (const file of ["infinity_notebook.js", "infinity_notebook_bg.wasm"]) {
  copy(path.join("..", "pkg", file), path.join("pkg", file));
}

// The wasm package stays a file of its own: it finds its .wasm next to itself.
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "index.js")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  external: ["./pkg/*"],
  logLevel: "warning",
});
