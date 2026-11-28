// What a page being read gets on top of plain Markdown: diagrams drawn from
// ```mermaid blocks, typeset math, and colour in code blocks that name their
// language. Each comes from a library that is only fetched by pages that use
// it.

const LINE = 30; // height of a ruled line, as in index.html

// ----------------------------------------------------------------- code

let highlighter; // highlight.js, once a page has needed it
let highlighterLoading;

function loadHighlighter() {
  return (highlighterLoading ??= import("highlight.js/lib/common").then((module) => { highlighter = module.default; }));
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const colourings = new Map(); // language and code -> where its colours are

/**
 * Where the colours of `code` are, for colouring it without rewriting it:
 * a list of { from, to, name }, with `name` the class of that stretch.
 * Empty until the library is there; `whenReady` is called once it is.
 */
export function coloursOf(code, language, whenReady) {
  if (!language) return [];
  if (!highlighter) {
    loadHighlighter().then(whenReady, () => {});
    return [];
  }
  if (!highlighter.getLanguage(language)) return [];
  const key = `${language}\n${code}`;
  if (!colourings.has(key)) {
    if (colourings.size > 300) colourings.clear();
    // The library answers with the code escaped and its own spans around
    // the coloured parts; this reads where those spans are.
    const html = highlighter.highlight(code, { language, ignoreIllegals: true }).value;
    const stretches = [];
    const open = [];
    let at = 0;
    for (const [piece, name] of html.matchAll(/<span class="([^"]*)">|<\/span>|&[^;]+;|[^<&]+/g)) {
      if (name !== undefined) open.push(name);
      else if (piece === "</span>") open.pop();
      else {
        const length = (ENTITIES[piece] ?? piece).length;
        if (open.length > 0) stretches.push({ from: at, to: at + length, name: open.join(" ") });
        at += length;
      }
    }
    colourings.set(key, at === code.length ? stretches : []);
  }
  return colourings.get(key);
}

/** Colours the code blocks under `root` that say what language they are in. */
function colourCode(root) {
  const blocks = [...root.querySelectorAll('pre > code[class*="language-"]')].filter((code) => !code.dataset.coloured);
  if (blocks.length === 0) return;
  if (!highlighter) {
    loadHighlighter().then(() => colourCode(root), () => { /* the code stays as it is */ });
    return;
  }
  for (const code of blocks) {
    const language = /language-([\w+#-]+)/.exec(code.className)?.[1].toLowerCase();
    code.dataset.coloured = "yes";
    // The code is in rows, one for each of its lines, and stays so.
    const lines = [...code.querySelectorAll(".row")];
    const texts = lines.map((line) => line.textContent.replace(/\n$/, ""));
    const stretches = coloursOf(texts.join("\n"), language);
    if (stretches.length === 0) continue;
    let start = 0;
    let next = 0;
    lines.forEach((line, index) => {
      const text = texts[index];
      const end = start + text.length;
      const pieces = [];
      let at = start;
      while (next < stretches.length && stretches[next].from < end) {
        const { from, to, name } = stretches[next];
        const [first, last] = [Math.max(from, start), Math.min(to, end)];
        if (first < last) {
          if (first > at) pieces.push(text.slice(at - start, first - start));
          const piece = document.createElement("span");
          piece.className = name;
          piece.textContent = text.slice(first - start, last - start);
          pieces.push(piece);
          at = last;
        }
        if (to > end) break; // the rest of it is on the next line
        next++;
      }
      pieces.push(`${text.slice(at - start)}\n`);
      line.replaceChildren(...pieces);
      start = end + 1;
    });
  }
  markTurns(root);
}

/**
 * Marks where a line of code too long for the page has been broken: a small
 * arrow after the last character before the break. A space that the line
 * was broken at keeps its place, between that character and the arrow, so
 * that it shows whether there is one.
 */
function markTurns(root) {
  const range = document.createRange();
  for (const row of root.querySelectorAll("pre .row")) {
    for (const mark of row.querySelectorAll(".turn")) mark.remove();
    row.normalize();
    if (row.getBoundingClientRect().height < 1.5 * LINE) continue;
    const breaks = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let top;
    let before; // the last character that is not a space, and the spaces after it
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let at = 0; at < node.data.length; at++) {
        if (node.data[at] === "\n") continue;
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const here = range.getBoundingClientRect().top;
        if (top !== undefined && here - top > LINE / 2 && before) breaks.push(before);
        top = Math.max(top ?? here, here);
        if (node.data[at] === " " && before) before = { ...before, spaces: before.spaces + 1 };
        else before = { node, at: at + 1, spaces: 0 };
      }
    }
    // from the end, so that the places found stay where they are
    for (const { node, at, spaces } of breaks.reverse()) {
      const mark = document.createElement("span");
      mark.className = "turn";
      mark.style.setProperty("--spaces", spaces);
      node.splitText(at).before(mark);
    }
  }
}

// ----------------------------------------------------------------- math

let katex;          // KaTeX, once a page has needed it
let katexLoading;

/** KaTeX's style sheet, which brings its fonts. */
function loadMathStyles() {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./katex/katex.min.css", document.baseURI).href;
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
}

/** Typesets the math under `root`. Until then it shows as it was written. */
function typesetMath(root) {
  const pieces = [...root.querySelectorAll(".math:not(.typeset)")];
  if (pieces.length === 0) return;
  if (!katex) {
    katexLoading ??= Promise.all([import("katex"), loadMathStyles()]).then(([module]) => { katex = module.default; });
    katexLoading.then(() => {
      typesetMath(root);
      snap(root);
      // its fonts arrive a little later still, and change heights
      document.fonts?.ready.then(() => snap(root));
    }, () => { /* the math stays as it was written */ });
    return;
  }
  for (const piece of pieces) {
    piece.classList.add("typeset");
    try {
      katex.render(piece.dataset.tex, piece, {
        displayMode: piece.classList.contains("display"),
        throwOnError: false,
        errorColor: "#c8452f",
      });
    } catch {
      // not math after all: leave the text
    }
  }
}

// -------------------------------------------------------------- the rules

/**
 * Keeps the writing on the rules. Most of a page is a whole number of lines
 * tall by its styling; math, tables and the like may not be, and are padded
 * to the next line so that what follows them is on the rules again.
 */
export function snap(root) {
  fitTables(root);
  markTurns(root);
  for (const block of root.children) {
    // (a diagram sets its own height, and code is whole lines by its styling)
    if (block.classList.contains("diagram") || block.tagName === "PRE") continue;
    block.style.paddingTop = block.style.paddingBottom = "";
    const over = block.getBoundingClientRect().height % LINE;
    if (over < 0.5 || LINE - over < 0.5) continue;
    // A formula on lines of its own sits in the middle of them, and so
    // does a table that has been made smaller, with some room around it.
    const small = block.matches(".table.small");
    const centred = small || block.matches(".math.display");
    const room = LINE - over + (small && LINE - over < 12 ? LINE : 0);
    block.style.paddingBottom = `${room / (centred ? 2 : 1)}px`;
    if (centred) block.style.paddingTop = block.style.paddingBottom;
  }
}

/**
 * A table too wide for the window is made smaller, writing and all, until
 * it fits. Its rows are then no longer the lines of the page, so it gets a
 * ground of its own (the "small" class).
 */
function fitTables(root) {
  for (const holder of root.querySelectorAll(".table")) {
    const table = holder.firstElementChild;
    holder.classList.remove("small");
    table.style.zoom = "";
    if (table.offsetWidth <= holder.clientWidth + 0.5) continue;
    holder.classList.add("small");
    const scale = holder.clientWidth / table.offsetWidth;
    if (scale < 1) table.style.zoom = scale;
  }
}

/** Links to another place on the page (footnotes) go there, not to another page. */
function followWithinPage(event) {
  const link = event.target.closest?.('a[href^="#"]');
  if (!link) return;
  event.preventDefault();
  const target = document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
  if (target && event.currentTarget.contains(target)) target.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ------------------------------------------------------------- diagrams

// Diagrams are drawn with these stand-in colours, which are then swapped for
// the page's own (CSS variables). A drawing so follows light and dark mode,
// and print, without being drawn again.
const STAND_INS = {
  "#010203": "var(--ink)",
  "#fdfeff": "var(--paper)",
  "#7b7c7d": "var(--faded-ink)",
  "#dbdcdd": "var(--rule)",
  "#c3c4c5": "var(--accent)",
  "#a3a4a5": "var(--code-blue)",
  "#b3b4b5": "var(--code-green)",
  "#939495": "var(--code-brown)",
};
const [INK, PAPER, FADED, RULE, ACCENT, BLUE, GREEN, BROWN] = Object.keys(STAND_INS);
// Some colours come back from the library written as rgb(r, g, b).
const SWAPS = new Map();
for (const [hex, colour] of Object.entries(STAND_INS)) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  SWAPS.set(hex, colour);
  SWAPS.set(`rgb(${r},${g},${b})`, colour);
}
const STAND_IN = new RegExp(`${Object.keys(STAND_INS).join("|")}|rgb\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\)`, "gi");
const FONT = "Handlee, 'Comic Sans MS', cursive";

let mermaid;                    // the library, once a page has needed it
let drawing = Promise.resolve(); // it draws one diagram at a time
let drawn = 0;
const drawings = new Map();     // source -> the finished SVG, or null if it cannot be drawn

async function loadMermaid() {
  if (mermaid) return;
  const module = await import("mermaid");
  await document.fonts?.load(`19px Handlee`).catch(() => {});
  mermaid = module.default;
  const natural = { useMaxWidth: false };
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Drawn by hand, in the handwriting of the page and at its size.
    look: "handDrawn",
    handDrawnSeed: 7,
    theme: "base",
    fontFamily: FONT,
    fontSize: 19,
    htmlLabels: false,
    flowchart: { ...natural, htmlLabels: false },
    sequence: {
      ...natural,
      actorFontFamily: FONT, noteFontFamily: FONT, messageFontFamily: FONT,
      actorFontSize: 19, noteFontSize: 19, messageFontSize: 19,
    },
    gantt: natural, journey: natural, class: natural, state: natural, er: natural,
    pie: natural, gitGraph: natural, mindmap: natural, timeline: natural, quadrantChart: natural,
    xyChart: natural, requirement: natural, c4: natural, sankey: natural, block: natural, kanban: natural,
    themeVariables: {
      fontFamily: FONT,
      fontSize: "19px",
      background: PAPER,
      primaryColor: PAPER, primaryTextColor: INK, primaryBorderColor: INK,
      secondaryColor: RULE, secondaryTextColor: INK, secondaryBorderColor: FADED,
      tertiaryColor: PAPER, tertiaryTextColor: INK, tertiaryBorderColor: FADED,
      lineColor: INK, textColor: INK, titleColor: INK,
      mainBkg: PAPER, nodeBorder: INK, nodeTextColor: INK,
      clusterBkg: PAPER, clusterBorder: FADED,
      edgeLabelBackground: PAPER, defaultLinkColor: INK,
      noteBkgColor: RULE, noteTextColor: INK, noteBorderColor: FADED,
      actorBkg: PAPER, actorBorder: INK, actorTextColor: INK, actorLineColor: FADED,
      signalColor: INK, signalTextColor: INK,
      labelBoxBkgColor: PAPER, labelBoxBorderColor: INK, labelTextColor: INK, loopTextColor: INK,
      activationBkgColor: RULE, activationBorderColor: INK, sequenceNumberColor: PAPER,
      classText: INK, labelColor: INK, altBackground: RULE, errorBkgColor: RULE, errorTextColor: ACCENT,
      pie1: BLUE, pie2: GREEN, pie3: BROWN, pie4: ACCENT, pie5: FADED, pie6: RULE, pie7: PAPER,
      pie8: BLUE, pie9: GREEN, pie10: BROWN, pie11: ACCENT, pie12: FADED,
      pieStrokeColor: INK, pieOuterStrokeColor: INK, pieStrokeWidth: "1.5px", pieOpacity: "0.55",
      pieTitleTextColor: INK, pieSectionTextColor: INK, pieLegendTextColor: INK,
    },
  });
}

/** Draws a diagram; resolves to its SVG, or null if the source is not a diagram. */
function draw(source) {
  if (!drawings.has(source)) {
    drawings.set(source, (drawing = drawing.then(async () => {
      try {
        await loadMermaid();
        const { svg } = await mermaid.render(`diagram-${++drawn}`, source);
        return svg.replace(STAND_IN, (colour) => SWAPS.get(colour.toLowerCase().replace(/\s/g, "")) ?? colour);
      } catch {
        return null;
      }
    })));
  }
  return drawings.get(source);
}

/**
 * Puts a drawing in its place. It keeps its own size, where the writing in it
 * is as large as the writing on the page, unless that is wider than the
 * window: then all of it shrinks to fit. It takes up whole lines. Its title
 * is taken out of the drawing and written on the page, on the rules, with
 * room between it and the drawing.
 */
function place(figure, svg) {
  figure.innerHTML = svg;
  const picture = figure.querySelector("svg");
  if (!picture) return;
  // What is written in a drawing is not on the rules of the page, so where
  // it would stand on bare paper it gets a ground of its own: the key of a
  // pie chart, and the pie itself, which is see-through.
  const NS = "http://www.w3.org/2000/svg";
  for (const slice of picture.querySelectorAll(".pieCircle")) {
    const ground = slice.cloneNode(false);
    ground.setAttribute("class", "ground");
    ground.removeAttribute("style");
    slice.before(ground);
  }
  const key = [...picture.querySelectorAll("g.legend")];
  if (key.length > 0) {
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const entry of key) {
      const box = entry.getBoundingClientRect();
      [left, top, right, bottom] = [Math.min(left, box.left), Math.min(top, box.top), Math.max(right, box.right), Math.max(bottom, box.bottom)];
    }
    const [first, origin] = [key[0], key[0].parentNode.getScreenCTM()];
    const patch = document.createElementNS(NS, "rect");
    const pad = 8;
    patch.setAttribute("class", "ground");
    patch.setAttribute("x", (left - origin.e) / origin.a - pad);
    patch.setAttribute("y", (top - origin.f) / origin.d - pad);
    patch.setAttribute("width", (right - left) / origin.a + 2 * pad);
    patch.setAttribute("height", (bottom - top) / origin.d + 2 * pad);
    patch.setAttribute("rx", 8);
    first.before(patch);
  }
  picture.removeAttribute("style");
  figure.classList.add("drawn");
  const box = picture.viewBox.baseVal;
  let width = picture.width.baseVal.unitType === SVGLength.SVG_LENGTHTYPE_PERCENTAGE || !picture.getAttribute("width") ? box.width : picture.width.baseVal.value;
  let caption;
  const title = picture.querySelector('text[class$="TitleText"], text.titleText');
  if (title?.textContent.trim()) {
    caption = document.createElement("figcaption");
    caption.textContent = title.textContent.trim();
    title.remove();
    // the drawing is now only what is left of it
    const rest = picture.getBBox();
    if (rest.width > 0 && rest.height > 0) {
      const edge = 3; // the strokes are drawn a little outside their shapes
      picture.setAttribute("viewBox", `${rest.x - edge} ${rest.y - edge} ${rest.width + 2 * edge} ${rest.height + 2 * edge}`);
      width = rest.width + 2 * edge;
    }
    figure.prepend(caption);
  }
  picture.setAttribute("width", width);
  picture.removeAttribute("height");
  const fit = () => {
    const titled = caption ? caption.getBoundingClientRect().height : 0;
    // under a title, the drawing gets at least half a line above and below
    const drawing = picture.getBoundingClientRect().height + (caption ? LINE : 0);
    figure.style.height = `${titled + Math.ceil(drawing / LINE) * LINE}px`;
  };
  figure.style.height = "";
  fit();
  figure.refit = fit;
}

/** Draws the diagrams under `root`. Until one is drawn its source shows. */
function drawDiagrams(root) {
  // (one that is still being written is left as its source until it is whole)
  for (const figure of root.querySelectorAll(".diagram:not(.drawn):not(.unfinished)")) {
    const source = figure.dataset.source;
    draw(source).then((svg) => {
      // The page may have changed while this was being drawn.
      if (svg && figure.isConnected && figure.dataset.source === source) place(figure, svg);
    });
  }
}

const pages = new Set(); // the elements that pages have been rendered into

// A narrower window may shrink a drawing, which then needs fewer lines, and
// wraps the writing differently.
window.addEventListener("resize", () => {
  for (const figure of document.querySelectorAll(".diagram.drawn")) figure.refit?.();
  for (const root of pages) snap(root);
});

/** Dresses up a page that has just been rendered into `root`. */
export function enhance(root) {
  if (!pages.has(root)) {
    pages.add(root);
    root.addEventListener("click", followWithinPage);
    // a folded section that opens or closes changes the height of its block
    root.addEventListener("toggle", () => snap(root), true);
  }
  colourCode(root);
  typesetMath(root);
  drawDiagrams(root);
  snap(root);
}
