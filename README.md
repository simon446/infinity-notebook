# Infinity Notebook

See https://simon446.github.io/infinity-notebook/

## How pages are numbered

A page's text is compressed with a language model, the idea from 3Blue1Brown's
[cross entropy videos](https://github.com/3b1b/videos/tree/master/_2026/cross_entropy):
[SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) predicts each next token and an
arithmetic coder (`src/coder.rs`) spends about `-log2(probability)` bits on it. The resulting
bits are the page number (the `#p123...` in the URL), so text the model finds likely lands
on low page numbers.

The model is bundled in `www/model` (8-bit ONNX weights, split into parts below GitHub's
file size limit) and runs in the browser through `onnxruntime-web`. Decoding a page needs
exactly the numbers that were produced when it was encoded, so the model runs on the CPU in
single-threaded WebAssembly, one token at a time. Changing the model file, the tokenizer or
the `onnxruntime-web` version renumbers every page.

## Building

```
cd www
npm install
npm run build   # builds the Rust wasm package and writes www/dist
```

Needs Rust with the `wasm32-unknown-unknown` target and Node. On pushes to master, GitHub
Actions runs this build and commits the result to `docs/`, which GitHub Pages serves.

## Credits

- <a href="https://codepen.io/MarcMalignan/pen/QbaXGg">Paper Styling by Marc Malignan</a>
- https://github.com/3b1b/videos
- [SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) by Hugging Face (Apache-2.0), ONNX weights from [onnx-community](https://huggingface.co/onnx-community/SmolLM2-135M-ONNX)
