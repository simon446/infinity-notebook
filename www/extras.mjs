// What a page being read gets on top of plain Markdown: diagrams drawn from
// ```mermaid blocks, and colour in code blocks that name their language.
// Both come from libraries that are only fetched by pages that use them.

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
};
const [INK, PAPER, FADED, RULE, ACCENT] = Object.keys(STAND_INS);
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
      pie1: RULE, pie2: FADED, pie3: ACCENT, pie4: PAPER, pieStrokeColor: INK, pieOuterStrokeColor: INK,
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
        return svg.replace(new RegExp(Object.keys(STAND_INS).join("|"), "gi"), (colour) => STAND_INS[colour.toLowerCase()]);
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

// A narrower window may shrink a drawing, which then needs fewer lines.
window.addEventListener("resize", () => {
  for (const figure of document.querySelectorAll(".diagram.drawn")) figure.refit?.();
});

/** Dresses up a page that has just been rendered into `root`. */
export function enhance(root) {
  colourCode(root);
  drawDiagrams(root);
}
