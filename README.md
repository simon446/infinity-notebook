# Infinity Notebook

See https://simon446.me/

## How pages are numbered

A page's text is compressed with a language model, the idea from 3Blue1Brown's
[cross entropy videos](https://github.com/3b1b/videos/tree/master/_2026/cross_entropy):
[SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) predicts each next token and an
arithmetic coder (`src/coder.rs`) spends about `-log2(probability)` bits on it. The resulting
bits are the page number (the `#page=123...` in the URL), so text the model finds likely lands
on low page numbers. The link button copies a shorter address for the same page, with the
number written in base 64 (`#Kx9...`). A page may hold as much as
fits in a short link of 2000 characters, which is several thousand characters of ordinary
writing.

Decoding a page needs exactly the numbers that were produced when it was encoded, on every
device. So the model does not run on a general runtime or a GPU but in `src/model.rs`, a
small engine for this one model: the matrix products are exact integer arithmetic (8-bit
weights, WebAssembly SIMD) and the rest is float arithmetic in a fixed order. `tests/golden.rs`
pins a known page; if it fails, a change has renumbered every page.

The weights are bundled in `www/model`, split into parts below GitHub's file size limit.
They are made from the original model with

```
python3 tools/convert_weights.py model.safetensors www/model
```

## The page

A page is edited as rich text and kept as Markdown: the Markdown is what gets a page number.
The editor (`www/editor.mjs`) is [ProseMirror](https://prosemirror.net) with its own
`prosemirror-markdown`, without images or link syntax, and with line breaks kept as line
breaks. Addresses in the text are shown as links without being stored as such.

A page opens for reading: just the ruled page and its writing. The pencil in the corner
brings out the page number, page flipping and formatting.

## Building

```
cd www
npm install
npm run build   # builds the Rust wasm package, bundles the page and writes www/dist
```

Needs Rust with the `wasm32-unknown-unknown` target and Node. On pushes to master, GitHub
Actions runs this build and commits the result to `docs/`, which GitHub Pages serves.

## Credits

- <a href="https://codepen.io/MarcMalignan/pen/QbaXGg">Paper Styling by Marc Malignan</a>
- https://github.com/3b1b/videos
- [SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) by Hugging Face (Apache-2.0)
