// Markdown as it is rendered for reading.
//
// CommonMark, with what people expect of Markdown on top: tables,
// strikethrough, task lists, footnotes, callouts, math, diagrams and a
// collapsible section. No other HTML and no images: a page is text, and a
// random page should not make the browser fetch whatever address it happens
// to name. A line break in the text is a line break on the page. Links are
// those written as [text](address) and any address written out with its
// scheme (https://...).

import MarkdownIt from "markdown-it";
import footnotes from "markdown-it-footnote";

export const markdownIt = MarkdownIt("commonmark", { html: false, breaks: true, linkify: true })
  .enable(["linkify", "table", "strikethrough"])
  .disable("image")
  .use(footnotes);
export const linkify = markdownIt.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

const { escapeHtml } = markdownIt.utils;
const rules = markdownIt.renderer.rules;

// Links open in a new tab, and tell the site nothing about this page.
rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer nofollow");
  return self.renderToken(tokens, index, options);
};

// A ```mermaid block is a diagram. It is rendered as its source, which
// extras.mjs then replaces with the drawing.
const renderFence = rules.fence;
rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token.info.trim().toLowerCase() !== "mermaid") return renderFence(tokens, index, options, env, self);
  const source = escapeHtml(token.content);
  // On a page that is still being read out, the last diagram may not be all
  // there yet: it is whole once its closing fence has come.
  const unfinished = env.growing && tokens.slice(index + 1).every((later) => later.nesting === -1)
    && !/\n\s*(`{3,}|~{3,})\s*$/.test(env.source);
  return `<figure class="diagram${unfinished ? " unfinished" : ""}" data-source="${source}"><pre><code>${source}</code></pre></figure>\n`;
};

// A table can be wider than the page: it then scrolls sideways on its own.
rules.table_open = () => '<div class="table"><table>\n';
rules.table_close = () => "</table></div>\n";

// Math, written as $...$ within a line and $$...$$ on lines of its own. It
// is rendered as its source, which extras.mjs then typesets.
markdownIt.inline.ruler.after("escape", "math", (state, silent) => {
  const { src, pos } = state;
  if (src[pos] !== "$") return false;
  const fence = src[pos + 1] === "$" ? "$$" : "$";
  const start = pos + fence.length;
  // "$5 and $10" is money: math does not start with a space or end with one,
  // and is not followed by a digit.
  if (start >= src.length || /\s/.test(src[start])) return false;
  let end = start;
  for (;;) {
    end = src.indexOf(fence, end);
    if (end < 0) return false;
    if (src[end - 1] !== "\\") break;
    end += 1;
  }
  if (end === start || /\s/.test(src[end - 1]) || /\d/.test(src[end + fence.length] ?? "")) return false;
  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = src.slice(start, end);
    token.markup = fence;
  }
  state.pos = end + fence.length;
  return true;
});

markdownIt.block.ruler.before("fence", "math", (state, startLine, endLine, silent) => {
  const lineText = (line) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const first = lineText(startLine).trim();
  if (!first.startsWith("$$")) return false;
  let last = startLine;
  let content;
  if (first.length > 4 && first.endsWith("$$")) {
    content = first.slice(2, -2);
  } else {
    const lines = [first.slice(2)];
    for (last = startLine + 1; ; last++) {
      if (last >= endLine) return false;
      const text = lineText(last).trim();
      if (text.endsWith("$$")) {
        lines.push(text.slice(0, -2));
        break;
      }
      lines.push(text);
    }
    content = lines.join("\n");
  }
  if (silent) return true;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}, { alt: ["paragraph", "blockquote", "list"] });

rules.math_inline = (tokens, index) => {
  const tex = escapeHtml(tokens[index].content);
  return `<span class="math" data-tex="${tex}">$${tex}$</span>`;
};
rules.math_block = (tokens, index) => {
  const tex = escapeHtml(tokens[index].content);
  return `<div class="math display" data-tex="${tex}">${tex}</div>\n`;
};

// A section that folds away, written as it is on GitHub:
//   <details>
//   <summary>What shows</summary>
//   ...what is folded...
//   </details>
markdownIt.block.ruler.before("paragraph", "details", (state, startLine, _endLine, silent) => {
  const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
  const summary = /^<summary>(.*)<\/summary>$/i.exec(line);
  const open = /^<details>$/i.test(line);
  const close = /^<\/details>$/i.test(line);
  if (!summary && !open && !close) return false;
  if (silent) return true;
  if (open) {
    state.push("details_open", "details", 1).block = true;
  } else if (close) {
    state.push("details_close", "details", -1).block = true;
  } else {
    state.push("summary_open", "summary", 1);
    const inline = state.push("inline", "", 0);
    inline.content = summary[1];
    inline.map = [startLine, startLine + 1];
    inline.children = [];
    state.push("summary_close", "summary", -1).block = true;
  }
  state.line = startLine + 1;
  return true;
}, { alt: ["paragraph", "blockquote", "list"] });

const CALLOUTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/** Takes `length` characters off the start of an inline token's text. */
function cutStart(inline, length) {
  inline.content = inline.content.slice(length);
  const first = inline.children[0];
  if (first?.type !== "text") return;
  first.content = first.content.slice(length);
  if (first.content === "") {
    inline.children.shift();
    // the line break that followed the mark goes with it
    if (inline.children[0]?.type === "softbreak") inline.children.shift();
  }
}

// Task lists (- [ ] and - [x]) and callouts (> [!TIP]) are ordinary lists
// and quotes whose first words say what they are.
markdownIt.core.ruler.push("tasks_and_callouts", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const inline = tokens[i + 2];
    if (tokens[i + 1].type !== "paragraph_open" || inline.type !== "inline") continue;
    if (tokens[i].type === "list_item_open") {
      const box = /^\[([ xX])\](\s+|$)/.exec(inline.content);
      if (!box) continue;
      tokens[i].attrJoin("class", box[1] === " " ? "task" : "task done");
      cutStart(inline, box[0].length);
    } else if (tokens[i].type === "blockquote_open") {
      const mark = /^\[!(\w+)\][ \t]*(\n|$)/.exec(inline.content);
      const kind = mark?.[1].toLowerCase();
      if (!mark || !CALLOUTS[kind]) continue;
      tokens[i].attrJoin("class", `callout ${kind}`);
      cutStart(inline, mark[0].length);
      const title = new state.Token("callout_title", "p", 0);
      title.content = CALLOUTS[kind];
      title.block = true;
      tokens.splice(i + 1, 0, title);
    }
  }
});
rules.callout_title = (tokens, index) => `<p class="callout-title">${escapeHtml(tokens[index].content)}</p>\n`;

/** The page's first large heading, if it has one. */
export function titleOf(markdown) {
  const tokens = markdownIt.parse(markdown, {});
  const heading = tokens.findIndex((token) => token.type === "heading_open" && token.tag === "h1");
  if (heading < 0) return undefined;
  const words = (tokens[heading + 1].children ?? []).filter((child) => child.type === "text" || child.type === "code_inline");
  return words.map((child) => child.content).join("").trim() || undefined;
}
