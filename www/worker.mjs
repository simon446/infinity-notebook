// Runs the language model off the page's thread, so the page can scroll and
// take input while a page is being read or searched for.
//
// The page sends { id, type: "decode", page } or { id, type: "encode", text },
// and { type: "abort", id } to give up on one. This answers, tagged with the
// same id, with "started" once the model is ready, then "text" (decode) or
// "progress" (encode) as it goes, and finally "done" or "error". Download
// progress goes out untagged as "fetched".

import initWasm, * as wasm from "./pkg/infinity_notebook.js";
import { loadLanguageModel } from "./llm.mjs";

let modelPromise;
function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      await initWasm();
      wasm.init();
      return loadLanguageModel(wasm, (done, total) => postMessage({ type: "fetched", done, total }));
    })();
    modelPromise.catch(() => { modelPromise = undefined; });
  }
  return modelPromise;
}

const signals = new Map();
let queue = Promise.resolve(); // the model does one thing at a time

async function work({ id, type, page, text }, signal) {
  let model;
  try {
    model = await getModel();
  } catch (error) {
    postMessage({ id, type: "error", message: String(error), fetchFailed: true });
    return;
  }
  try {
    postMessage({ id, type: "started" });
    let result;
    if (type === "decode") {
      result = await model.decode(page, (text) => postMessage({ id, type: "text", text }), signal);
    } else {
      const number = await model.encode(text, (done, total) => postMessage({ id, type: "progress", done, total }), signal);
      result = { number, text: model.normalize(text) };
    }
    postMessage({ id, type: "done", result });
  } catch (error) {
    postMessage({ id, type: "error", message: String(error) });
  }
}

onmessage = ({ data }) => {
  if (data.type === "abort") {
    const signal = signals.get(data.id);
    if (signal) signal.aborted = true;
    return;
  }
  const signal = {};
  signals.set(data.id, signal);
  queue = queue.then(() => work(data, signal)).finally(() => signals.delete(data.id));
};
