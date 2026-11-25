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

  // The wasm package stays files of its own (it finds its .wasm next to
  // itself), in a folder named after their contents.
  const packageFiles = ["infinity_notebook.js", "infinity_notebook_bg.wasm"];
  const hash = crypto.createHash("sha256");
  for (const file of packageFiles) hash.update(fs.readFileSync(path.join(__dirname, "..", "pkg", file)));
  const packageFolder = `pkg-${hash.digest("hex").slice(0, 10)}`;
  for (const file of packageFiles) copy(path.join("..", "pkg", file), path.join(packageFolder, file));

  const bundle = async (entry, define = {}) => {
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, entry)],
      outdir: dist,
      entryNames: "[name]-[hash]",
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
    return path.basename(Object.keys(result.metafile.outputs)[0]);
  };

  // The worker that runs the language model, then the page's script, which
  // needs to know the worker's name.
  const worker = await bundle("worker.mjs");
  const script = await bundle("index.js", { WORKER_FILE: JSON.stringify(`./${worker}`) });

  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  if (!page.includes('src="./index.js"')) throw new Error("index.html does not load ./index.js");
  fs.writeFileSync(path.join(dist, "index.html"), page.replace('src="./index.js"', `src="./${script}"`));
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
