// Collects the static site into dist/: the page, the Rust wasm package that
// wasm-pack built into ../pkg, the language model's weights and the tokenizer.
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "dist");
const copy = (from, to) => fs.cpSync(path.join(__dirname, from), path.join(dist, to), { recursive: true });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "pkg"), { recursive: true });

for (const file of [
  "index.html",
  "index.js",
  "llm.mjs",
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

copy(
  path.join("node_modules", "@huggingface/tokenizers/dist/tokenizers.min.mjs"),
  path.join("vendor", "tokenizers.min.mjs")
);
