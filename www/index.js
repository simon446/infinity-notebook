import initWasm, * as wasm from "./pkg/infinity_notebook.js";
import { canonical, createEditor } from "./editor.mjs";

await initWasm();
wasm.init();

const pageNumberElement = document.getElementById('pagenum');
const previousButton = document.getElementById('previous');
const nextButton = document.getElementById('next');
const randomButton = document.getElementById('random');
const linkButton = document.getElementById('link');
const sheet = document.getElementById('sheet');
const tools = document.getElementById('tools');
const note = document.getElementById('note');
const noteText = document.getElementById('note-text');
const noteProgress = document.getElementById('note-progress');
const noteAction = document.getElementById('note-action');
const editButton = document.getElementById('edit');
const doneButton = document.getElementById('done');

// Without a keyboard there is no shortcut to mention.
const touch = window.matchMedia('(pointer: coarse)').matches;
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "\u2318 + Enter" : "Ctrl + Enter";

// A tab with nothing written in it, until the page has been read.
const BLANK_TITLE = "\u200e";

// Pages are Markdown. The page shows it as rich text, and gives it back in
// one fixed spelling: `canonical(text)` is how `text` reads once on the page.
const FIRST_PAGE = canonical(wasm.first_page());

let pageNumber;          // the page being shown, as a decimal string
let pageContent = "";    // its Markdown as the page gives it back, once known
let written = "";        // the Markdown last put on the page
let searchMode = false;  // the page was edited and can be searched for
let busy = false;        // a page is being read or searched for
let editing = false;     // the page can be written on, and its tools are out
let leaveWhenFound = false; // the search under way was started by "Find page"
let job = {};            // the work for the current page
let justFound;           // the page number a search just led to
let lostEnd = "";        // what that search could not fit on the page
const knownPages = new Map([["1", wasm.first_page()]]);

// What the sticky note says while the notebook is busy. Each list is cycled
// through so a long wait does not show the same line all the time.
const MESSAGES = {
    fetching: [
        "Hauling the notebook off the shelf. It is heavier than it looks",
        "Still carrying. Infinity weighs about 135 MB",
        "Almost at the desk",
    ],
    opening: ["Blowing the dust off the cover"],
    searching: [
        "Flipping through the pages",
        "Licking a finger, flipping faster",
        "Past the grocery lists",
        "Somewhere after the love letters",
        "It has to be in here somewhere",
        "Skipping a few trillion pages",
    ],
    closing: ["Getting warmer", "Nearly there", "Just a few more pages"],
};
const MESSAGE_SECONDS = 2.8;
let phase, phaseStart;

/** The current line for a phase of work, with trailing dots that grow. */
function message(name) {
    if (phase !== name) {
        phase = name;
        phaseStart = Date.now();
    }
    const seconds = (Date.now() - phaseStart) / 1000;
    const lines = MESSAGES[name];
    return lines[Math.floor(seconds / MESSAGE_SECONDS) % lines.length] + ".".repeat(1 + Math.floor(seconds * 2) % 3);
}

/**
 * Puts up the sticky note.
 * @param progress a fraction for a pencil line of that length, "scribble"
 *   for work of unknown length, or nothing for no pencil
 * @param action a button: { label, run }
 */
let noteTimer;
function showNote(text, { progress, action, seconds } = {}) {
    clearTimeout(noteTimer);
    noteText.textContent = text;
    noteProgress.hidden = progress === undefined;
    noteProgress.classList.toggle('scribble', progress === "scribble");
    if (typeof progress === "number") noteProgress.style.setProperty('--progress', `${Math.round(100 * progress)}%`);
    noteAction.hidden = !action;
    if (action) {
        noteAction.textContent = action.label;
        noteAction.onclick = action.run;
    }
    note.hidden = false;
    if (seconds) noteTimer = setTimeout(hideNote, 1000 * seconds);
}

function hideNote() {
    clearTimeout(noteTimer);
    note.hidden = true;
    phase = undefined;
}

/** Reports work in progress; repeats itself so the wording keeps moving. */
let workTimer;
function showWork(describe) {
    clearInterval(workTimer);
    const update = () => {
        const { text, progress } = describe();
        showNote(text, { progress });
    };
    workTimer = setInterval(update, 400);
    update();
    return update;
}

function stopWork() {
    clearInterval(workTimer);
}

// The language model runs in a worker, which fetches it the first time a page
// needs it. See worker.mjs for the messages.
let worker;
let modelReady = false;
let fetched = 0;
let lastRequest = 0;
const requests = new Map();

function startWorker() {
    // WORKER_FILE is the worker's file name, filled in by build.js.
    worker = new Worker(new URL(WORKER_FILE, import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
        if (data.type === "fetched") {
            fetched = data.done / data.total;
            return;
        }
        const request = requests.get(data.id);
        if (!request) return;
        if (data.type === "started") {
            modelReady = true;
            request.onStart?.();
        } else if (data.type === "text") {
            request.onText?.(data.text);
        } else if (data.type === "progress") {
            request.onProgress?.(data.done, data.total);
        } else {
            requests.delete(data.id);
            if (data.type === "done") request.resolve(data.result);
            else request.reject(Object.assign(new Error(data.message), { fetchFailed: !!data.fetchFailed }));
        }
    };
    worker.onerror = (event) => {
        // The worker itself could not start: nothing it was asked will be answered.
        for (const request of requests.values()) {
            request.reject(Object.assign(new Error(event.message || "worker failed"), { fetchFailed: true }));
        }
        requests.clear();
        worker = undefined;
        fetched = 0;
    };
}

/**
 * Asks the worker to read or find a page. Aborting `forJob` gives up on it.
 * @param handlers onStart, onText and onProgress callbacks
 */
function ask(message, handlers, forJob) {
    if (!worker) startWorker();
    const id = ++lastRequest;
    forJob.cancel = () => worker?.postMessage({ type: "abort", id });
    return new Promise((resolve, reject) => {
        requests.set(id, { ...handlers, resolve, reject });
        worker.postMessage({ ...message, id });
    }).catch((error) => {
        if (error.fetchFailed) fetched = 0;
        throw error;
    });
}

function describeFetching() {
    return fetched < 1
        ? { text: message("fetching"), progress: fetched }
        : { text: message("opening"), progress: "scribble" };
}

function pageName(number) {
    return wasm.get_pagename(number).trim();
}

function showPageName() {
    pageNumberElement.value = "Page " + pageName(pageNumber);
    previousButton.disabled = pageNumber === "1";
}

const content = document.getElementById('content');
const editor = createEditor(content, {
    onEdit: edited,
    onSubmit: () => search(),
    onState: showFormatting,
});

/**
 * Sets every kind of writing exactly on the rules.
 *
 * A rule is the last pixel row of each line. For each kind of writing this
 * measures where a line's baseline falls and how far below the baseline its
 * letters reach once drawn (bold reaches a little further, small type less),
 * then shifts that kind so its ink ends on the row above a rule. All of it
 * is in device pixels, so it holds on any screen.
 */
function setWritingOnRules() {
    const ratio = window.devicePixelRatio || 1;
    const line = parseFloat(getComputedStyle(content).lineHeight);
    // Measured on a hidden twin of the page, so the editor never sees it.
    const twin = document.createElement('div');
    twin.className = content.className;
    twin.style.cssText = 'position:absolute;visibility:hidden;top:0;left:0;padding:0;min-height:0';
    sheet.append(twin);

    const measure = (tag, inner = "") => {
        const probe = document.createElement(tag);
        probe.style.cssText = 'position:absolute;visibility:hidden;top:0;left:0;white-space:nowrap;margin:0';
        probe.innerHTML = `${inner}Hnmhi<span style="display:inline-block;width:0;height:0"></span>`;
        twin.append(probe);
        const writing = probe.querySelector('strong, code') ?? probe;
        const style = getComputedStyle(writing);
        const baseline = probe.querySelector('span').getBoundingClientRect().top - probe.getBoundingClientRect().top;
        const lines = Math.round(parseFloat(getComputedStyle(probe).lineHeight) / line);
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const size = parseFloat(style.fontSize);
        probe.remove();
        return { baseline, lines, sink: inkBelowBaseline(font, size, ratio) };
    };

    const text = measure('p');
    // The device row a line's baseline has to be on for its ink to end just
    // above the rule, as a distance from the top of the line.
    const baselineRow = (kind) => (kind.lines * line - 1) - kind.sink / ratio;
    const shiftText = baselineRow(text) - text.baseline;
    sheet.style.setProperty('--shift-text', `${shiftText}px`);
    for (const [name, tag, inner] of [['h1', 'h1'], ['h2', 'h2'], ['h3', 'h3'], ['h4', 'h4'], ['pre', 'pre']]) {
        const kind = measure(tag, inner);
        sheet.style.setProperty(`--shift-${name}`, `${baselineRow(kind) - kind.baseline - shiftText}px`);
    }
    // Inline styles share the line's baseline and only differ in how far they reach.
    for (const [name, inner] of [['strong', '<strong>'], ['code', '<code>']]) {
        const kind = measure('p', inner);
        sheet.style.setProperty(`--shift-${name}`, `${(text.sink - kind.sink) / ratio}px`);
    }
    twin.remove();
}

/**
 * How many device pixel rows the letters of a font reach below its baseline
 * (negative if they stop short of it), found by drawing them.
 */
function inkBelowBaseline(font, size, ratio) {
    const canvas = document.createElement('canvas');
    const baseline = Math.ceil(size * 1.5 * ratio);
    canvas.width = Math.ceil(size * 5 * ratio);
    canvas.height = baseline + Math.ceil(size * ratio);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.scale(ratio, ratio);
    context.font = font;
    context.textBaseline = 'alphabetic';
    context.fillText('Hnmhi', 2, baseline / ratio);
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    // The lowest inked row of every column; letters stand on the baseline
    // with their stems, so most columns that reach low end at the same row.
    const bottoms = [];
    for (let x = 0; x < width; x++) {
        for (let y = height - 1; y >= 0; y--) {
            if (data[4 * (y * width + x) + 3] > 127) {
                bottoms.push(y);
                break;
            }
        }
    }
    if (bottoms.length === 0) return 0;
    bottoms.sort((a, b) => a - b);
    return bottoms[Math.floor(bottoms.length * 0.8)] + 1 - baseline;
}

/** Puts Markdown on the page. */
function write(markdown) {
    written = markdown;
    editor.setMarkdown(markdown);
}

/** Lights up the formatting buttons that apply at the cursor. */
function showFormatting() {
    for (const button of tools.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', editor.active(button.dataset.format));
    }
}

// A page holds what fits in a link: the short link to it (see shortLink) may
// be this long. 2000 characters is what a chat message commonly allows, and
// far below what browsers accept in an address.
const MAX_LINK_LENGTH = 2000;
// Longer than this cannot fit however predictable the text; not worth trying.
const MAX_PAGE_LENGTH = 12000;

/** The largest page number, in bits, whose short link is short enough. */
function maxPageBits() {
    return 6 * (MAX_LINK_LENGTH - (window.location.href.split('#')[0].length + 1));
}

/**
 * Says that the end of what was written did not fit on the page, and offers
 * it back. `rest` is the Markdown that was left off.
 */
function showFellOff(rest) {
    showNote("I ran out of page! The end of what you wrote fell off the bottom. A page only holds what fits in its link.", {
        action: {
            label: "Copy what fell off",
            run: async () => {
                const copied = await copy(rest);
                showNote(copied ? "The rest is on your clipboard. Try the next page." : "I could not reach the clipboard, sorry.", { seconds: 5 });
            },
        },
    });
}

// A short link writes the page number in base 64 with the URL-safe alphabet:
// six bits a character, where decimal digits carry a little over three.
const SHORT_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function shortCode(number) {
    let code = "";
    for (let rest = BigInt(number); rest > 0n; rest >>= 6n) code = SHORT_DIGITS[Number(rest & 63n)] + code;
    return code;
}

/** The address of a page, as short as it can be written. */
function shortLink(number) {
    const code = shortCode(number);
    // A code that reads as "p" and digits would be taken for the older form
    // of link to another page, so such a page keeps its long address.
    const fragment = /^p\d+$/.test(code) ? 'page=' + number : code;
    return window.location.href.split('#')[0] + '#' + fragment;
}

// Pages live in the URL as #page=<page number>. A short link (#<code>) and
// the older #p<page number> lead to the same pages.
function pageNumberFromHash() {
    const hash = window.location.hash;
    const decimal = /^#p(?:age=)?(\d+)$/.exec(hash);
    let number;
    if (decimal) {
        number = BigInt(decimal[1]);
    } else if (/^#[A-Za-z0-9_-]+$/.test(hash)) {
        number = 0n;
        for (const digit of hash.slice(1)) number = number * 64n + BigInt(SHORT_DIGITS.indexOf(digit));
    } else {
        return undefined;
    }
    return number === 0n ? undefined : number.toString();
}

function jumpTo(number) {
    // Compare with the URL, not `pageNumber`, which lags behind it for a
    // moment after every jump.
    if (number === pageNumberFromHash()) showPage();
    else window.location.hash = 'page=' + number;
}

/**
 * A page is for reading until the pencil is pressed. Then it can be written
 * on, and the page number, the page flipping and the formatting come out.
 */
function setEditing(value) {
    editing = value;
    document.body.classList.toggle('editing', editing);
    syncEditable();
    if (editing) editor.focus();
    else if (!busy) hideNote();
}

function setBusy(value) {
    busy = value;
    syncEditable();
}

function syncEditable() {
    editor.setEditable(editing && !busy);
}

/** The button that ends editing finds the page first if it was changed. */
function showDone() {
    doneButton.textContent = searchMode ? "Find page" : "Done";
    doneButton.classList.toggle('primary', searchMode);
    doneButton.title = searchMode && !touch ? `Find the page this is written on (${shortcut})` : "";
}

/** The tab is named after the page's first large heading. */
function showTitle() {
    window.document.title = editor.title() || "Notes";
}

async function showPage() {
    const number = pageNumberFromHash();
    if (number === undefined || window.location.hash !== '#page=' + number) {
        window.location.replace('#page=' + (number ?? "1"));
        return;
    }

    job.aborted = true;
    job.cancel?.();
    const thisJob = job = {};
    stopWork();
    pageNumber = number;
    searchMode = false;
    showDone();
    showPageName();
    if (!knownPages.has(number)) window.document.title = BLANK_TITLE;

    // What is on the page stays there until the new page differs from it, so
    // that flipping between similar pages does not flicker.
    const before = searchMode ? editor.getMarkdown() : written;

    if (!knownPages.has(number)) {
        setBusy(true);
        if (modelReady) hideNote();
        else showWork(describeFetching);
        let latest, frame;
        try {
            const text = await ask({ type: "decode", page: number }, {
                onStart() {
                    if (thisJob.aborted) return;
                    stopWork();
                    hideNote();
                },
                // Text arrives token by token; the page is redrawn once a frame.
                onText(text) {
                    latest = text;
                    frame ??= requestAnimationFrame(() => {
                        frame = undefined;
                        if (!thisJob.aborted && !thisJob.finished && !before.startsWith(latest)) write(latest);
                    });
                },
            }, thisJob);
            thisJob.finished = true;
            knownPages.set(number, text);
        } catch (error) {
            if (thisJob.aborted) return;
            console.error(error);
            stopWork();
            setBusy(false);
            showNote(
                error.fetchFailed
                    ? "The notebook slipped on the way to the desk. Shall I pick it up again?"
                    : "This page is smudged beyond reading. Shall I try once more?",
                { action: { label: "Try again", run: showPage } }
            );
            return;
        }
        if (thisJob.aborted) return;
        stopWork();
    }

    write(knownPages.get(number));
    pageContent = editor.getMarkdown();
    setBusy(false);
    showTitle();
    if (justFound === number && lostEnd !== "") {
        showFellOff(lostEnd);
    } else if (justFound === number) {
        showNote(pageContent === "" ? "Found it! The one blank page in the whole notebook." : "Found it! It was on this page all along.", { seconds: 4 });
    } else if (pageContent === "") {
        showNote("Nothing on this page yet. Whatever you write here already has a page of its own.", { seconds: 5 });
    } else {
        hideNote();
    }
    justFound = undefined;
    lostEnd = "";
}

/** Finds the page that what is written is on. `thenLeave` ends editing there. */
async function search(thenLeave = false) {
    if (busy || !searchMode) return;
    leaveWhenFound = thenLeave;
    // Far more than a page: do not even try the part that can never fit.
    const all = editor.getMarkdown();
    const text = all.slice(0, MAX_PAGE_LENGTH);
    let fellOff = all.slice(MAX_PAGE_LENGTH);
    const thisJob = job;
    setBusy(true);
    let done = 0, total = 0;
    showWork(() => {
        if (total === 0) return describeFetching();
        const progress = done / total;
        return { text: message(progress < 0.7 ? "searching" : "closing"), progress };
    });
    try {
        let number = "1";
        if (text !== FIRST_PAGE) {
            const found = await ask({ type: "encode", text, maxBits: maxPageBits() }, {
                onProgress(tokensDone, tokens) {
                    done = tokensDone;
                    total = Math.max(tokens, 1);
                },
            }, thisJob);
            number = found.number;
            fellOff = found.rest + fellOff;
            knownPages.set(number, found.text);
        }
        if (thisJob.aborted) return;
        stopWork();
        justFound = number;
        lostEnd = fellOff;
        if (leaveWhenFound) setEditing(false);
        jumpTo(number);
    } catch (error) {
        if (thisJob.aborted) return;
        console.error(error);
        stopWork();
        setBusy(false);
        showNote(
            error.fetchFailed
                ? "The notebook slipped on the way to the desk. Shall I pick it up again?"
                : "I lost my place somewhere around page a-gazillion. Shall I start over?",
            { action: { label: "Try again", run: () => search(thenLeave) } }
        );
    }
}

/** The person changed the page. */
function edited() {
    if (busy) return;
    searchMode = editor.getMarkdown() !== pageContent;
    showDone();
    showTitle();
    // A note with a button on it stays until it has been dealt with.
    if (noteAction.hidden) hideNote();
}

editButton.addEventListener('click', () => setEditing(true));

// "Done" puts the pencil down. If the page was changed it first finds the
// page that the writing is on.
doneButton.addEventListener('click', function () {
    if (busy) return;
    if (searchMode) search(true);
    else setEditing(false);
});

tools.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor on the page
tools.addEventListener('click', function (e) {
    const button = e.target.closest('button');
    if (button && !busy) editor.run(button.dataset.format);
});

// The page number shows the page's name, and its digits while being edited.
pageNumberElement.addEventListener('focus', function () {
    pageNumberElement.value = pageNumber;
    setTimeout(() => pageNumberElement.select(), 10);
});

pageNumberElement.addEventListener('input', function () {
    const digits = pageNumberElement.value.replace(/\D/g, '');
    if (digits !== pageNumberElement.value) pageNumberElement.value = digits;
    if (digits !== "" && digits !== pageNumber) {
        turnOffered = true;
        showNote(touch ? "Shall I turn to that page?" : "Press Enter and I will turn to that page.", {
            action: { label: "Turn the page", run: () => turnTo(digits) },
        });
    }
});

let turnOffered = false; // the note is offering to turn to a typed page number

function turnTo(digits) {
    const number = digits === "" ? "0" : BigInt(digits).toString();
    pageNumberElement.blur();
    if (number !== "0") jumpTo(number);
}

pageNumberElement.addEventListener('blur', function () {
    showPageName();
    if (!turnOffered) return;
    turnOffered = false;
    // Leave the offer up for a moment: a tap on its button comes after the blur.
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        if (busy) return;
        hideNote();
    }, 4000);
});

pageNumberElement.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') turnTo(pageNumberElement.value);
    else if (e.key === 'Escape') pageNumberElement.blur();
});

// Flip from the page in the URL, which is ahead of `pageNumber` for a moment
// after every jump.
function flip(pages) {
    const number = BigInt(pageNumberFromHash() ?? pageNumber) + pages;
    if (number >= 1n) jumpTo(number.toString());
}
previousButton.addEventListener('click', () => flip(-1n));
nextButton.addEventListener('click', () => flip(1n));

// Page Up and Page Down flip pages, and so do the arrow keys while nothing
// is being typed.
document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const typing = editor.hasFocus() || document.activeElement === pageNumberElement;
    let pages;
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !typing)) pages = 1n;
    else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !typing)) pages = -1n;
    else return;
    e.preventDefault();
    flip(pages);
});

// A quick sideways swipe across the page flips it too, unless there are
// edits on it that a stray swipe would throw away.
let swipe;
sheet.addEventListener('touchstart', function (e) {
    const { clientX: x, clientY: y } = e.touches[0];
    swipe = e.touches.length === 1 ? { x, y, time: Date.now() } : undefined;
}, { passive: true });
sheet.addEventListener('touchend', function (e) {
    if (!swipe || searchMode) return;
    const { clientX: x, clientY: y } = e.changedTouches[0];
    const [dx, dy] = [x - swipe.x, y - swipe.y];
    const quick = Date.now() - swipe.time < 600;
    swipe = undefined;
    if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < 2.5 * Math.abs(dy)) return;
    if (window.getSelection().toString() !== "") return;
    flip(dx < 0 ? 1n : -1n);
}, { passive: true });

randomButton.addEventListener('click', function () {
    // Anything from a short scribble to a few lines of text.
    const digits = 8 + Math.floor(Math.random() * 60);
    let number = String(1 + Math.floor(Math.random() * 9));
    while (number.length < digits) number += Math.floor(Math.random() * 10);
    randomButton.classList.remove('rolling');
    void randomButton.offsetWidth;
    randomButton.classList.add('rolling');
    jumpTo(number);
});

/** Copies text to the clipboard; false if the browser will not allow it. */
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Older browsers, and pages not served over HTTPS.
        const field = document.createElement('textarea');
        field.value = text;
        field.style.cssText = 'position:fixed;opacity:0';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        return copied;
    }
}

linkButton.addEventListener('click', async function () {
    if (busy) return;
    const link = shortLink(pageNumber);
    const copied = await copy(link);
    showNote(copied ? "Copied a short link to this page. Paste it anywhere to come back here." : `Here is a short link to this page: ${link}`);
    // Make room again for the note that was up, if any.
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        if (busy) return;
        hideNote();
    }, copied ? 3500 : 12000);
});

// The handwriting font arrives after the page; measure again once it has.
setWritingOnRules();
if (document.fonts) {
    document.fonts.ready.then(setWritingOnRules);
    document.fonts.addEventListener('loadingdone', setWritingOnRules);
    const sizes = ['400 19px', '700 19px', '700 34px'];
    Promise.all(sizes.map((size) => document.fonts.load(`${size} Handlee`))).then(setWritingOnRules, () => {});
}
window.addEventListener('resize', setWritingOnRules);
window.addEventListener('hashchange', showPage);
showPage();
