// Turns page numbers into text and back with SmolLM2-135M.
//
// The text of a page is arithmetic coded with the model's next-token
// predictions (the coder lives in src/coder.rs). Decoding only works if the
// model produces exactly the same numbers as when the page was encoded, on
// every machine. So the model always runs one token at a time, on the CPU,
// in single-threaded WebAssembly, with a pinned onnxruntime-web build.

export const EOS = 0; // <|endoftext|>
const SPECIAL_TOKENS = 17; // ids below this are special tokens, never text
export const MAX_TEXT_LENGTH = 2000;

export class LanguageModel {
  /**
   * @param ort the onnxruntime-web module
   * @param session an ort.InferenceSession for the SmolLM2-135M ONNX model
   * @param tokenizer a @huggingface/tokenizers Tokenizer
   * @param coder the infinity-notebook wasm module
   */
  constructor(ort, session, tokenizer, coder) {
    this.ort = ort;
    this.session = session;
    this.tokenizer = tokenizer;
    this.coder = coder;
    // The empty key/value cache a context starts with, one pair per layer.
    this.pastNames = session.inputNames.filter((name) => name.startsWith("past_key_values."));
    const { shape } = session.inputMetadata.find((input) => input.name === this.pastNames[0]);
    this.pastShape = [1, shape[1], 0, shape[3]];
    this.usesPositions = session.inputNames.includes("position_ids");
  }

  tokenize(text) {
    const { ids } = this.tokenizer.encode(text, { add_special_tokens: false });
    return ids.filter((id) => id >= SPECIAL_TOKENS);
  }

  detokenize(tokens) {
    return this.tokenizer.decode(tokens, { skip_special_tokens: false });
  }

  /** The text that `text` will read back as after a trip through the model. */
  normalize(text) {
    return this.detokenize(this.tokenize(text));
  }

  /**
   * A fresh context. Each call to the returned function feeds one token and
   * resolves to the logits for the token after it.
   */
  predictor() {
    const { ort, session } = this;
    let past = {};
    for (const name of this.pastNames) {
      past[name] = new ort.Tensor("float32", new Float32Array(0), this.pastShape);
    }
    let position = 0;
    return async (token) => {
      const feeds = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(token)]), [1, 1]),
        attention_mask: new ort.Tensor("int64", new BigInt64Array(position + 1).fill(1n), [1, position + 1]),
        ...past,
      };
      if (this.usesPositions) {
        feeds.position_ids = new ort.Tensor("int64", BigInt64Array.from([BigInt(position)]), [1, 1]);
      }
      const outputs = await session.run(feeds);
      for (const tensor of Object.values(past)) tensor.dispose?.();
      past = {};
      for (const [name, tensor] of Object.entries(outputs)) {
        if (name.startsWith("present.")) past[name.replace("present.", "past_key_values.")] = tensor;
      }
      position += 1;
      return outputs.logits.data;
    };
  }

  /**
   * The page number (decimal string) of `text`.
   * @param onProgress called with (tokens done, tokens in total)
   * @param signal set `signal.aborted` to give up; the promise then rejects
   */
  async encode(text, onProgress = () => {}, signal = {}) {
    const tokens = this.tokenize(text);
    const predict = this.predictor();
    const encoder = new this.coder.PageEncoder(EOS);
    // The end-of-text token doubles as the start marker.
    let logits = await predict(EOS);
    for (let i = 0; i < tokens.length; i++) {
      if (signal.aborted) throw new Error("aborted");
      onProgress(i, tokens.length);
      encoder.push(logits, tokens[i]);
      logits = await predict(tokens[i]);
    }
    onProgress(tokens.length, tokens.length);
    return encoder.finish(logits);
  }

  /**
   * The text of a page (number as decimal string, at least 2).
   * @param onText called with the text so far after every token
   * @param signal set `signal.aborted` to give up; the promise then rejects
   */
  async decode(pageNumber, onText = () => {}, signal = {}) {
    const decoder = this.coder.PageDecoder.create(pageNumber, EOS);
    if (!decoder) return undefined;
    const predict = this.predictor();
    const tokens = [];
    let text = "";
    let previous = EOS;
    while (!decoder.exhausted()) {
      if (signal.aborted) throw new Error("aborted");
      const token = decoder.next(await predict(previous));
      if (token < SPECIAL_TOKENS) break;
      tokens.push(token);
      const longer = this.detokenize(tokens);
      if (longer.length > MAX_TEXT_LENGTH) break;
      text = longer;
      previous = token;
      onText(text);
    }
    decoder.free();
    return text;
  }
}

// Bump when the files in model/ or the onnxruntime-web version change, so
// browsers drop their stored copies.
const MODEL_CACHE = "infinity-notebook-model-v2";

/** Browser storage for the model and its runtime, if this browser offers any. */
async function openModelCache() {
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith("infinity-notebook-model-") && name !== MODEL_CACHE) await caches.delete(name);
    }
    // Ask the browser not to evict the model when disk space runs low.
    navigator.storage?.persist?.().catch(() => {});
    return await caches.open(MODEL_CACHE);
  } catch {
    return undefined; // e.g. private browsing; the model is then downloaded on every visit
  }
}

/** Like fetch, but keeps the file in `cache` so it is only downloaded once. */
async function cachedFetch(cache, url) {
  const stored = await cache?.match(url);
  if (stored) return stored;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
  // Storing is best effort: without it the file is downloaded again next time.
  await cache?.put(url, response.clone()).catch(() => {});
  return response;
}

/** Reads a response body into `target`, reporting each chunk's size. */
async function readInto(response, target, onBytes) {
  const reader = response.body.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > target.length) throw new Error(`${response.url} is larger than expected`);
    target.set(value, offset);
    offset += value.length;
    onBytes(value.length);
  }
  if (offset !== target.length) throw new Error(`${response.url} is incomplete`);
}

/**
 * Downloads a file that is stored as parts (listed in `<url>.json`) into one
 * Uint8Array. Parts are kept in `cache`, so each is downloaded once.
 * @param onProgress called with (bytes done, bytes in total)
 */
export async function fetchParts(url, cache, onProgress = () => {}) {
  const { parts } = await (await cachedFetch(cache, `${url}.json`)).json();
  const total = parts.reduce((size, part) => size + part.size, 0);
  const whole = new Uint8Array(total);
  let done = 0;
  onProgress(done, total);

  const download = async (part, offset) => {
    const partUrl = new URL(part.file, url).href;
    const target = whole.subarray(offset, offset + part.size);
    for (let attempt = 1; ; attempt++) {
      let received = 0;
      const onBytes = (count) => {
        received += count;
        done += count;
        onProgress(done, total);
      };
      try {
        const stored = await cache?.match(partUrl);
        if (stored) {
          await readInto(stored, target, onBytes);
          return;
        }
        const response = await fetch(partUrl);
        if (!response.ok) throw new Error(`Could not download ${partUrl}: ${response.status}`);
        await readInto(response, target, onBytes);
        // Storing is best effort: without it the part is downloaded again next time.
        await cache?.put(partUrl, new Response(target, { headers: { "Content-Length": String(part.size) } })).catch(() => {});
        return;
      } catch (error) {
        done -= received;
        await cache?.delete(partUrl).catch(() => {});
        if (attempt === 3) throw error;
      }
    }
  };

  // Two downloads at a time, each written straight into its place.
  const offsets = [];
  parts.reduce((offset, part, i) => ((offsets[i] = offset), offset + part.size), 0);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      await download(parts[i], offsets[i]);
    }
  };
  await Promise.all([worker(), worker()]);
  return whole;
}

/**
 * Loads the model from the files next to this module.
 * @param onProgress called with (bytes done, bytes in total) while downloading
 */
export async function loadLanguageModel(coder, onProgress = () => {}) {
  const file = (path) => new URL(path, import.meta.url).href;
  const cache = await openModelCache();
  const [ort, { Tokenizer }, runtime, tokenizerJson, tokenizerConfig, model] = await Promise.all([
    import("./vendor/ort.wasm.min.mjs"),
    import("./vendor/tokenizers.min.mjs"),
    cachedFetch(cache, file("vendor/ort-wasm-simd-threaded.wasm")).then((r) => r.arrayBuffer()),
    cachedFetch(cache, file("model/tokenizer.json")).then((r) => r.json()),
    cachedFetch(cache, file("model/tokenizer_config.json")).then((r) => r.json()),
    fetchParts(file("model/model_int8.onnx"), cache, onProgress),
  ]);
  ort.env.wasm.wasmPaths = file("vendor/");
  ort.env.wasm.wasmBinary = runtime;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  return new LanguageModel(ort, session, new Tokenizer(tokenizerJson, tokenizerConfig), coder);
}
