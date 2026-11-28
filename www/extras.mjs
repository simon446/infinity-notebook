// What a page being read gets on top of plain Markdown: diagrams drawn from
// ```mermaid blocks, typeset math, and colour in code blocks that name their
// language. Each comes from a library that is only fetched by pages that use
// it.

const LINE = 30; // height of a ruled line, as in index.html

// ----------------------------------------------------------------- code

let highlighter; // highlight.js, once a page has needed it

/** Colours the code blocks under `root` that say what language they are in. */
function colourCode(root) {
  const blocks = [...root.querySelectorAll('pre > code[class*="language-"]')].filter((code) => !code.dataset.coloured);
  if (blocks.length === 0) return;
  if (!highlighter) {
    import("highlight.js/lib/common").then((module) => {
      highlighter = module.default;
      colourCode(root);
    }, () => { /* the code stays as it is */ });
    return;
  }
  for (const code of blocks) {
    const language = /language-([\w+#-]+)/.exec(code.className)?.[1];
    code.dataset.coloured = "yes";
    if (!language || !highlighter.getLanguage(language)) continue;
    // highlight.js returns the code escaped, with only its own spans in it.
    code.innerHTML = highlighter.highlight(code.textContent, { language, ignoreIllegals: true }).value;
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
  for (const block of root.children) {
    if (block.classList.contains("diagram")) continue;
    block.style.paddingTop = block.style.paddingBottom = "";
    const over = block.getBoundingClientRect().height % LINE;
    if (over < 0.5 || LINE - over < 0.5) continue;
    // A formula on lines of its own sits in the middle of them.
    const centred = block.matches(".math.display");
    block.style.paddingBottom = `${(LINE - over) / (centred ? 2 : 1)}px`;
    if (centred) block.style.paddingTop = block.style.paddingBottom;
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
 * window: then all of it shrinks to fit. It takes up whole lines.
 */
function place(figure, svg) {
  figure.innerHTML = svg;
  const picture = figure.querySelector("svg");
  if (!picture) return;
  picture.removeAttribute("style");
  const box = picture.viewBox.baseVal;
  const width = picture.width.baseVal.unitType === SVGLength.SVG_LENGTHTYPE_PERCENTAGE || !picture.getAttribute("width") ? box.width : picture.width.baseVal.value;
  picture.setAttribute("width", width);
  picture.removeAttribute("height");
  figure.classList.add("drawn");
  const fit = () => { figure.style.height = `${Math.ceil(picture.getBoundingClientRect().height / LINE) * LINE}px`; };
  figure.style.height = "";
  fit();
  figure.refit = fit;
}

/** Draws the diagrams under `root`. Until one is drawn its source shows. */
function drawDiagrams(root) {
  for (const figure of root.querySelectorAll(".diagram:not(.drawn)")) {
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
