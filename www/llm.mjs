// Turns page numbers into text and back with SmolLM2-135M.
//
// The text of a page is arithmetic coded with the model's next-token
// predictions. Both the model (src/model.rs) and the coder (src/coder.rs) run
// in the infinity-notebook wasm module, written so that every machine gets
// exactly the same numbers. This file adds the tokenizer and the downloads.

import { Tokenizer } from "@huggingface/tokenizers";

// No page is longer than this many characters. What a page can hold is really
// set by its link (see MAX_LINK_LENGTH in index.js); this is for text so
// predictable, or page numbers so long, that the link would not stop them.
export const MAX_TEXT_LENGTH = 12000;

// Bump when the files in model/ change, so browsers drop their stored copies.
const MODEL_CACHE = "infinity-notebook-model-v3";

/** Lets the browser handle input and repaint between tokens. */
const channel = new MessageChannel();
let resume = () => {};
channel.port1.onmessage = () => resume();
function pause() {
  return new Promise((resolve) => {
    resume = resolve;
    channel.port2.postMessage(0);
  });
}

export class LanguageModel {
  /**
   * @param wasm the infinity-notebook wasm module
   * @param model a wasm.Model
   * @param tokenizer a @huggingface/tokenizers Tokenizer
   */
  constructor(wasm, model, tokenizer) {
    this.wasm = wasm;
    this.model = model;
    this.tokenizer = tokenizer;
  }

  tokenize(text) {
    const { ids } = this.tokenizer.encode(text, { add_special_tokens: false });
    return ids.filter((id) => this.wasm.is_text_token(id));
  }

  detokenize(tokens) {
    if (tokens.length === 0) return "";
    return this.tokenizer.decode(tokens, { skip_special_tokens: false });
  }

  /** The text that `text` will read back as after a trip through the model. */
  normalize(text) {
    return this.detokenize(this.tokenize(text));
  }

  /**
   * The page number (decimal string) of `text`, or of as much of it as fits.
   * @param onProgress called with (tokens done, tokens in total)
   * @param signal set `signal.aborted` to give up; the promise then rejects
   * @param maxBits the largest page number allowed, in bits
   * @returns { number, text, rest }: the page, the text on it, and whatever
   *   of `text` did not fit (empty if all of it did)
   */
  async encode(text, onProgress = () => {}, signal = {}, maxBits = Infinity) {
    const tokens = this.tokenize(text);
    const fits = (number) => BigInt(number).toString(2).length <= maxBits;

    // Encode until the text ends or the number has too many bits.
    let encoder = new this.wasm.PageEncoder(this.model);
    let kept = tokens.length;
    try {
      for (let i = 0; i < tokens.length; i++) {
        onProgress(i, tokens.length);
        await pause();
        if (signal.aborted) throw new Error("aborted");
        encoder.push(tokens[i]);
        if (encoder.bits() > maxBits) {
          kept = i;
          break;
        }
      }
    } catch (error) {
      encoder.free();
      throw error;
    }
    onProgress(tokens.length, tokens.length);
    let number = kept === tokens.length ? encoder.finish() : (encoder.free(), undefined);

    // Too long: keep fewer tokens until the page fits. The model remembers
    // what it worked out above, so trying again costs next to nothing.
    while (number === undefined || !fits(number)) {
      if (number !== undefined) kept -= 1;
      // End on a whole word: stop before a token that starts a new one.
      while (kept > 0 && !/^\s/.test(this.detokenize([tokens[kept]]))) kept -= 1;
      encoder = new this.wasm.PageEncoder(this.model);
      for (const token of tokens.slice(0, kept)) encoder.push(token);
      number = encoder.finish();
      if (kept === 0) break;
    }

    const whole = this.detokenize(tokens);
    const onPage = this.detokenize(tokens.slice(0, kept)).replace(/\uFFFD+$/, "");
    return { number, text: onPage, rest: kept === tokens.length ? "" : whole.slice(onPage.length) };
  }

  /**
   * The text of a page (number as decimal string, at least 2).
   * @param onText called with the text so far after every token
   * @param signal set `signal.aborted` to give up; the promise then rejects
   */
  async decode(pageNumber, onText = () => {}, signal = {}) {
    const decoder = this.wasm.PageDecoder.create(this.model, pageNumber);
    if (!decoder) return undefined;
    const tokens = [];
    let text = "";
    try {
      for (;;) {
        await pause();
        if (signal.aborted) throw new Error("aborted");
        const token = decoder.next();
        if (token === undefined) break;
        tokens.push(token);
        const longer = this.detokenize(tokens);
        if (longer.length > MAX_TEXT_LENGTH) break;
        // A character can span several tokens. Until its last one arrives it
        // reads as a broken character, which is left out of the text. A page
        // can also end in the middle of a character.
        text = longer.replace(/\uFFFD+$/, "");
        onText(text);
      }
    } finally {
      decoder.free();
    }
    return text;
  }
}

/** Browser storage for the model, if this browser offers any. */
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
export async function loadLanguageModel(wasm, onProgress = () => {}) {
  const file = (path) => new URL(path, import.meta.url).href;
  const cache = await openModelCache();
  const [tokenizerJson, tokenizerConfig, weights] = await Promise.all([
    cachedFetch(cache, file("model/tokenizer.json")).then((r) => r.json()),
    cachedFetch(cache, file("model/tokenizer_config.json")).then((r) => r.json()),
    fetchParts(file("model/model.bin"), cache, onProgress),
  ]);
  await pause();
  return new LanguageModel(wasm, new wasm.Model(weights), new Tokenizer(tokenizerJson, tokenizerConfig));
}
