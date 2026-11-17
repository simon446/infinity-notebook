import initWasm, * as wasm from "./pkg/infinity_notebook.js";
import { loadLanguageModel } from "./llm.mjs";

await initWasm();
wasm.init();

const paper = document.getElementById('content');
const pageNumberElement = document.getElementById('pagenum');
const baseTitle = window.document.title;

let pageNumber;          // the page being shown, as a decimal string
let pageContent = "";    // its text, once known
let searchMode = false;  // the text was edited: Enter searches for it
let busy = false;        // the language model is reading or searching
let job = {};            // the model work for the current page
const knownPages = new Map([["1", wasm.first_page()]]);

const MODEL_FAILED = "Could not load the language model";

// The language model is only fetched once a page actually needs it.
let modelPromise;
function getModel() {
    if (!modelPromise) {
        const megabytes = (bytes) => Math.round(bytes / 1e6);
        modelPromise = loadLanguageModel(wasm, (done, total) => showStatus(
            done < total
                ? `Loading language model (${megabytes(done)} of ${megabytes(total)} MB)`
                : "Starting language model"
        )).catch((error) => {
            modelPromise = undefined;
            error.modelFailed = true;
            throw error;
        });
    }
    return modelPromise;
}

// The model can only do one thing at a time.
let queue = Promise.resolve();
function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
}

function showStatus(text) {
    pageNumberElement.value = text;
    pageNumberElement.readOnly = true;
    pageNumberElement.classList.add("colored");
}

function showPageName() {
    pageNumberElement.value = "Page " + wasm.get_pagename(pageNumber);
    pageNumberElement.readOnly = false;
    pageNumberElement.classList.remove("colored");
}

function showPageContent() {
    paper.value = pageContent;
    paper.readOnly = false;
    paper.classList.remove("colored");
}

// Pages live in the URL as #p<page number>.
function pageNumberFromHash() {
    const match = /^#p(\d+)$/.exec(window.location.hash);
    if (!match) return undefined;
    const number = BigInt(match[1]).toString();
    return number === "0" ? undefined : number;
}

function jumpTo(number) {
    window.location.hash = 'p' + number;
}

async function showPage() {
    const number = pageNumberFromHash();
    if (number === undefined) {
        window.location.replace('#p1');
        return;
    }

    job.aborted = true;
    const thisJob = job = {};
    pageNumber = number;
    searchMode = false;
    window.document.title = `${baseTitle}: ${wasm.get_pagename(pageNumber)}`;

    if (!knownPages.has(number)) {
        busy = true;
        pageContent = "";
        paper.value = "";
        paper.readOnly = true;
        paper.classList.remove("colored");
        showStatus("Loading language model");
        try {
            const model = await getModel();
            const text = await enqueue(() => {
                if (!thisJob.aborted) showStatus("Reading page");
                return model.decode(number, (text) => { paper.value = text; }, thisJob);
            });
            knownPages.set(number, text);
        } catch (error) {
            if (thisJob.aborted) return;
            console.error(error);
            busy = false;
            showStatus(error.modelFailed ? MODEL_FAILED : "Could not read this page");
            return;
        }
        if (thisJob.aborted) return;
    }

    busy = false;
    pageContent = knownPages.get(number);
    showPageContent();
    showPageName();
}

async function search() {
    const text = wasm.limit_string_length(paper.value);
    const thisJob = job;
    busy = true;
    paper.readOnly = true;
    try {
        let number = "1";
        if (text !== wasm.first_page()) {
            showStatus("Loading language model");
            const model = await getModel();
            number = await enqueue(() => model.encode(
                text,
                (done, total) => { if (!thisJob.aborted) showStatus(`Searching (${done}/${total})`); },
                thisJob
            ));
            knownPages.set(number, model.normalize(text));
        }
        if (thisJob.aborted) return;
        if (number === pageNumber) showPage();
        else jumpTo(number);
    } catch (error) {
        if (thisJob.aborted) return;
        console.error(error);
        busy = false;
        paper.readOnly = false;
        showStatus(error.modelFailed ? MODEL_FAILED : "Could not search, press Enter to retry");
    }
}

paper.addEventListener('keypress', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (searchMode && !busy) search();
    }
});

paper.addEventListener('input', function (e) {
    if (busy) return;
    const limited = wasm.limit_string_length(paper.value);
    if (limited !== paper.value) paper.value = limited;
    if (paper.value === pageContent) {
        searchMode = false;
        showPageName();
    } else {
        searchMode = true;
        showStatus("Press Enter to search");
    }
});

pageNumberElement.addEventListener('input', function (e) {
    if (pageNumberElement.value === pageNumber) {
        showPageContent();
    } else {
        paper.value = "Press Enter to go to page";
        paper.readOnly = true;
        paper.classList.add("colored");
    }
});

pageNumberElement.addEventListener("focusin", function (e) {
    if (searchMode || busy) { e.preventDefault(); return; }
    pageNumberElement.value = pageNumber;
    setTimeout(() => { this.setSelectionRange(0, this.value.length) }, 10)
});

pageNumberElement.addEventListener('focusout', (event) => {
    if (searchMode || busy) return;
    showPageContent();
    showPageName();
});

pageNumberElement.addEventListener('keydown', function (e) {
    if (searchMode || busy) return;
    if (e.key === 'Enter') {
        const number = pageNumberElement.value;
        pageNumberElement.blur();
        if (/^\d+$/.test(number)) jumpTo(number);
    } else if (e.key === 'Escape') {
        pageNumberElement.blur();
    }
});

window.addEventListener('hashchange', showPage);
showPage();
