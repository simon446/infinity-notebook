// Builds the static site into dist/: the page with its scripts bundled, the
// Rust wasm package that wasm-pack built into ../pkg, the language model's
// weights and the tokenizer.
//
// Scripts and the wasm package get names that change with their contents. A
// browser can then never pair a fresh page with a stale script from its cache.
const crypto = require("crypto");
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "dist");
const copy = (from, to) => fs.cpSync(path.join(__dirname, from), path.join(dist, to), { recursive: true });

async function build() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  for (const file of ["favicon.ico", "favicon-32x32.png", "favicon-16x16.png", "apple-touch-icon.png", "card.png", "CNAME", "model"]) {
    copy(file, file);
  }

  // The hand that code is written in.
  for (const font of ["ComicMono.ttf", "ComicMono-Bold.ttf"]) copy(path.join("node_modules", "comic-mono", font), path.join("fonts", font));

  // What typeset math needs besides its script: a style sheet and its fonts
  // (the compact format only; every current browser reads it).
  copy(path.join("node_modules", "katex", "dist", "katex.min.css"), path.join("katex", "katex.min.css"));
  for (const font of fs.readdirSync(path.join(__dirname, "node_modules", "katex", "dist", "fonts"))) {
    if (font.endsWith(".woff2")) copy(path.join("node_modules", "katex", "dist", "fonts", font), path.join("katex", "fonts", font));
  }

  // The wasm package stays files of its own (it finds its .wasm next to
  // itself), in a folder named after their contents.
  const packageFiles = ["infinity_notebook.js", "infinity_notebook_bg.wasm"];
  const hash = crypto.createHash("sha256");
  for (const file of packageFiles) hash.update(fs.readFileSync(path.join(__dirname, "..", "pkg", file)));
  const packageFolder = `pkg-${hash.digest("hex").slice(0, 10)}`;
  for (const file of packageFiles) copy(path.join("..", "pkg", file), path.join(packageFolder, file));

  // The page's script is split: the libraries for diagrams and coloured
  // code go in files of their own, fetched only by pages that need them.
  const bundle = async (entry, define = {}, splitting = false) => {
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, entry)],
      outdir: dist,
      entryNames: "[name]-[hash]",
      chunkNames: "chunks/[name]-[hash]",
      splitting,
      bundle: true,
      format: "esm",
      target: "es2022",
      minify: true,
      define,
      metafile: true,
      logLevel: "warning",
      plugins: [{
        name: "wasm-package",
        setup(build) {
          build.onResolve({ filter: /^\.\/pkg\// }, (args) => ({
            path: args.path.replace("./pkg/", `./${packageFolder}/`),
            external: true,
          }));
        },
      }],
    });
    // Files loaded on demand count as entry points too; this is the one asked for.
    const [file] = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint && path.basename(output.entryPoint) === entry);
    return path.basename(file);
  };

  // The worker that runs the language model, then the page's script, which
  // needs to know the worker's name.
  const worker = await bundle("worker.mjs");
  const script = await bundle("index.js", { WORKER_FILE: JSON.stringify(`./${worker}`) }, true);

  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  if (!page.includes('src="./index.js"')) throw new Error("index.html does not load ./index.js");
  fs.writeFileSync(path.join(dist, "index.html"), page.replace('src="./index.js"', `src="./${script}"`));
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
