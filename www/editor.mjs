// The page, in its two forms.
//
// A page's text is Markdown, and it is edited as Markdown: what is typed is
// what the page holds, character for character. The source is only dressed up
// a little while editing (headings are larger, the marks of the syntax are
// fainter) and nothing in it is ever hidden or rewritten. Reading a page shows
// the same text rendered.

import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Fragment, Schema, Slice } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";

import { coloursOf, enhance } from "./extras.mjs";
import { linkify, markdownIt, titleOf } from "./markdown.mjs";

// ---------------------------------------------------------------- editing

// The source is a list of lines of plain text.
const schema = new Schema({
  nodes: {
    doc: { content: "line+" },
    line: { content: "text*", toDOM: () => ["div", { class: "line" }, 0], parseDOM: [{ tag: "div" }, { tag: "p" }] },
    text: {},
  },
});

const lineNode = (text) => schema.node("line", null, text === "" ? [] : [schema.text(text)]);
const toLines = (text) => text.replace(/\r\n?/g, "\n").split("\n").map(lineNode);
const toDoc = (text) => schema.node("doc", null, toLines(text));

function toText(doc) {
  const lines = [];
  doc.forEach((line) => lines.push(line.textContent));
  return lines.join("\n");
}

const HEADING = /^(#{1,6})(?=\s|$)/;
const QUOTE = /^(\s*>+\s?)/;
const BULLET = /^(\s*)([-*+])(\s+)/;
const NUMBERED = /^(\s*)(\d+)([.)])(\s+)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

// Marks within a line: `code`, **strong**, *emphasis*, [text](address), and a
// backslash before a character it escapes.
const INLINE = /(`+)(.+?)\1|(\*\*|__)(\S(?:.*?\S)?)\3|(\*|_)(\S(?:.*?\S)?)\5|\[([^\]\n]+)\]\(([^)\s]+)\)|\\[\\`*_{}[\]()#+\-.!>~]/g;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Dresses the source: which lines are headings, quotes or code, and which
 * characters are syntax. It only adds classes; the text is not touched.
 */
function dress(doc) {
  const dressing = [];
  let fence; // the fence of the code block the line is in, if any
  let block; // that block's language and lines of code
  // Code is coloured as it is when read.
  const colour = () => {
    const starts = [];
    let length = 0;
    for (const line of block.lines) {
      starts.push(length);
      length += line.text.length + 1;
    }
    const code = block.lines.map((line) => line.text).join("\n");
    for (const { from, to, name } of coloursOf(code, block.language, redress)) {
      block.lines.forEach((line, index) => {
        const [first, last] = [Math.max(from, starts[index]), Math.min(to, starts[index] + line.text.length)];
        if (first < last) dressing.push(Decoration.inline(line.start + first - starts[index], line.start + last - starts[index], { class: name }));
      });
    }
    block = undefined;
  };
  doc.forEach((line, offset) => {
    const start = offset + 1;
    const text = line.textContent;
    const wholeLine = (name) => dressing.push(Decoration.node(offset, offset + line.nodeSize, { class: name }));
    const span = (from, to, attrs) => { if (from < to) dressing.push(Decoration.inline(start + from, start + to, attrs)); };
    const syntax = (from, to) => span(from, to, { class: "syntax" });

    const fenced = FENCE.exec(text);
    if (fence) {
      wholeLine("code");
      if (fenced && fenced[1][0] === fence[0] && fenced[1].length >= fence.length && text.trim() === fenced[1]) {
        fence = undefined;
        colour();
      } else {
        block.lines.push({ start, text });
      }
      return;
    }
    if (fenced) {
      fence = fenced[1];
      block = { language: text.trim().slice(fence.length).trim().split(/\s+/)[0].toLowerCase(), lines: [] };
      wholeLine("code");
      return;
    }

    let match;
    if ((match = HEADING.exec(text))) {
      wholeLine(`h${match[1].length}`);
      syntax(0, match[1].length);
    } else if (RULE.test(text)) {
      syntax(0, text.length);
      return;
    } else if ((match = QUOTE.exec(text))) {
      wholeLine("quote");
      syntax(0, match[1].length);
    } else if ((match = BULLET.exec(text))) {
      syntax(match[1].length, match[1].length + match[2].length);
      // the box of a task
      if (/^\[[ xX]\](\s|$)/.test(text.slice(match[0].length))) syntax(match[0].length, match[0].length + 3);
    } else if ((match = NUMBERED.exec(text))) {
      syntax(match[1].length, match[1].length + match[2].length + match[3].length);
    }

    INLINE.lastIndex = 0;
    while ((match = INLINE.exec(text))) {
      const [all, ticks, , strong, , mark, , linkText, address] = match;
      const from = match.index;
      const to = from + all.length;
      if (ticks) {
        syntax(from, from + ticks.length);
        span(from + ticks.length, to - ticks.length, { nodeName: "code" });
        syntax(to - ticks.length, to);
      } else if (strong || mark) {
        const marker = strong ?? mark;
        // An underscore inside a word is just an underscore.
        if (marker[0] === "_" && (WORD.test(text[from - 1] ?? "") || WORD.test(text[to] ?? ""))) {
          INLINE.lastIndex = from + 1;
          continue;
        }
        syntax(from, from + marker.length);
        span(from + marker.length, to - marker.length, { nodeName: strong ? "strong" : "em" });
        syntax(to - marker.length, to);
        // What is inside may be marked up in turn.
        INLINE.lastIndex = from + marker.length;
      } else if (linkText) {
        syntax(from, from + 1);
        span(from + 1, from + 1 + linkText.length, { class: "address" });
        syntax(from + 1 + linkText.length, to);
      } else {
        syntax(from, from + 1);
      }
    }
    for (const found of linkify.match(text) ?? []) span(found.index, found.lastIndex, { class: "address" });
  });
  if (block) colour();
  return DecorationSet.create(doc, dressing);
}

// Dresses the source again, once what colours code has been fetched.
let redress = () => {};

const dressSource = new Plugin({
  state: {
    init: (_config, state) => dress(state.doc),
    apply: (transaction, dressing) => (transaction.docChanged || transaction.getMeta("redress") ? dress(transaction.doc) : dressing),
  },
  props: {
    decorations(state) {
      return dressSource.getState(state);
    },
  },
});

/** The lines the selection touches: [{ text, from }], `from` being where the line's text starts. */
function selectedLines(state) {
  const lines = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (node.type === schema.nodes.line) lines.push({ text: node.textContent, from: position + 1 });
    return false;
  });
  return lines;
}

/** Replaces the start of a line: `length` characters by `prefix`. */
function setPrefix(transaction, line, length, prefix) {
  const from = transaction.mapping.map(line.from, -1);
  if (prefix === "") transaction.delete(from, from + length);
  else transaction.replaceWith(from, from + length, schema.text(prefix));
}

/** A button that puts a mark at the start of the selected lines, or takes it off. */
function linePrefix(pattern, prefix) {
  const has = (line) => pattern.test(line.text);
  // What is at the start of a line now, which the mark replaces.
  const old = (line) => {
    const heading = /^#{1,6}(\s+|$)/.exec(line.text);
    return (heading ?? QUOTE.exec(line.text) ?? BULLET.exec(line.text) ?? NUMBERED.exec(line.text))?.[0] ?? "";
  };
  return {
    active: (state) => selectedLines(state).every(has),
    run(state, dispatch) {
      const lines = selectedLines(state);
      const remove = lines.every(has);
      const transaction = state.tr;
      lines.forEach((line, index) => {
        setPrefix(transaction, line, old(line).length, remove ? "" : typeof prefix === "function" ? prefix(index) : prefix);
      });
      dispatch(transaction.scrollIntoView());
      return true;
    },
  };
}

/** A button that puts a mark around the selection, or takes it off. */
function wrap(marker) {
  const around = (state) => {
    const { from, to, $from, $to } = state.selection;
    const size = marker.length;
    if (!$from.sameParent($to)) return false;
    const [start, end] = [$from.start(), $from.end()];
    if (from - size < start || to + size > end) return false;
    if (state.doc.textBetween(from - size, from) !== marker || state.doc.textBetween(to, to + size) !== marker) return false;
    // "**" around the selection is not "*" around it, though "***" is both.
    if (size === 1 && from - 2 >= start && state.doc.textBetween(from - 2, from) === marker + marker) {
      return from - 3 >= start && state.doc.textBetween(from - 3, from) === marker.repeat(3);
    }
    return true;
  };
  return {
    active: around,
    run(state, dispatch) {
      const { from, to, $from, $to } = state.selection;
      if (!$from.sameParent($to)) return false;
      const transaction = state.tr;
      if (around(state)) {
        transaction.delete(to, to + marker.length).delete(from - marker.length, from);
      } else {
        transaction.insertText(marker, to).insertText(marker, from);
        transaction.setSelection(TextSelection.create(transaction.doc, from + marker.length, to + marker.length));
      }
      dispatch(transaction.scrollIntoView());
      return true;
    },
  };
}

const COMMANDS = {
  strong: wrap("**"),
  em: wrap("*"),
  heading1: linePrefix(/^#(\s|$)/, "# "),
  heading2: linePrefix(/^##(\s|$)/, "## "),
  bullet_list: linePrefix(BULLET, "- "),
  ordered_list: linePrefix(NUMBERED, (index) => `${index + 1}. `),
  blockquote: linePrefix(/^\s*>/, "> "),
};

/**
 * Enter in a list or a quote starts the next item. On an item with nothing
 * in it, it ends the list instead.
 */
function continueList(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const text = $from.parent.textContent;
  const bullet = BULLET.exec(text);
  const numbered = NUMBERED.exec(text);
  const quote = !bullet && !numbered && QUOTE.exec(text);
  const start = (bullet ?? numbered ?? quote)?.[0];
  if (!start || $from.parentOffset < start.length) return false;
  const transaction = state.tr;
  if (text.length === start.length) {
    transaction.delete($from.start(), $from.end());
  } else {
    const next = numbered ? `${numbered[1]}${Number(numbered[2]) + 1}${numbered[3]}${numbered[4]}` : start;
    transaction.split($from.pos).insertText(next);
  }
  dispatch(transaction.scrollIntoView());
  return true;
}

/** Tab moves a list item a level in, Shift + Tab back out. */
function indent(direction) {
  return (state, dispatch) => {
    const lines = selectedLines(state).filter((line) => BULLET.test(line.text) || NUMBERED.test(line.text));
    if (lines.length === 0) return false;
    const transaction = state.tr;
    for (const line of lines) {
      if (direction > 0) setPrefix(transaction, line, 0, "  ");
      else setPrefix(transaction, line, /^ {0,2}/.exec(line.text)[0].length, "");
    }
    dispatch(transaction);
    return true;
  };
}

/** Text from elsewhere comes in as the lines it is. */
function linesSlice(text) {
  return new Slice(Fragment.from(toLines(text)), 1, 1);
}

/**
 * Sets up the page.
 * @param source the element to edit the Markdown in
 * @param reading the element that shows it rendered
 * @param onEdit called after the person changed the page
 * @param onSubmit called when they press Ctrl/Cmd + Enter
 * @param onState called after every change of text or cursor
 */
export function createEditor(source, reading, { onEdit, onSubmit, onState }) {
  let editable = true;
  let rendered;
  let enhancing;
  let enhanced = 0;
  const view = new EditorView(
    { mount: source },
    {
      state: EditorState.create({
        schema,
        plugins: [
          history(),
          keymap({
            "Mod-Enter": () => (onSubmit(), true),
            "Mod-z": undo,
            "Shift-Mod-z": redo,
            "Mod-y": redo,
            "Mod-b": (state, dispatch) => COMMANDS.strong.run(state, dispatch),
            "Mod-i": (state, dispatch) => COMMANDS.em.run(state, dispatch),
            Enter: chainCommands(continueList, baseKeymap.Enter),
            Tab: indent(1),
            "Shift-Tab": indent(-1),
          }),
          keymap(baseKeymap),
          dressSource,
        ],
      }),
      editable: () => editable,
      clipboardTextParser: linesSlice,
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, "\n"),
      // Whatever is pasted comes in as its plain text, never as formatting.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        view.dispatch(view.state.tr.replaceSelection(linesSlice(text)).scrollIntoView());
        return true;
      },
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction));
        if (transaction.docChanged && !transaction.getMeta("written")) onEdit();
        onState();
      },
    }
  );

  redress = () => view.dispatch(view.state.tr.setMeta("redress", true).setMeta("addToHistory", false));

  const editor = {
    getMarkdown: () => toText(view.state.doc),

    /**
     * Puts `markdown` on the page, touching only what differs from what is
     * there. `growing` says that more of it is still to come.
     */
    setMarkdown(markdown, growing = false) {
      const before = view.state.doc;
      const after = toDoc(markdown);
      const start = before.content.findDiffStart(after.content);
      if (start !== null) {
        let { a: endBefore, b: endAfter } = before.content.findDiffEnd(after.content);
        const overlap = start - Math.min(endBefore, endAfter);
        if (overlap > 0) {
          endBefore += overlap;
          endAfter += overlap;
        }
        const transaction = view.state.tr
          .replace(start, endBefore, after.slice(start, endAfter))
          .setMeta("written", true)
          .setMeta("addToHistory", false);
        view.dispatch(transaction);
      }
      editor.render(growing);
    },

    /**
     * Shows the page as it reads, from what the source holds now. Only the
     * blocks that differ from what is shown are replaced, so that a diagram
     * that has been drawn, say, stays while the page goes on below it.
     */
    render(growing = false) {
      const markdown = editor.getMarkdown();
      const key = `${growing ? "growing" : "whole"}\n${markdown}`;
      if (key === rendered) return;
      rendered = key;
      const fresh = document.createElement("template");
      fresh.innerHTML = markdownIt.render(markdown, { growing, source: markdown });
      for (const node of [...reading.childNodes]) if (node.renderedFrom === undefined) node.remove();
      const blocks = [...fresh.content.children];
      blocks.forEach((block, index) => {
        const html = block.outerHTML;
        const shown = reading.children[index];
        if (shown?.renderedFrom === html) return;
        block.renderedFrom = html;
        if (shown) shown.replaceWith(block);
        else reading.append(block);
      });
      while (reading.children.length > blocks.length) reading.lastElementChild.remove();
      // Diagrams, math and coloured code: at once for what has just come,
      // but not more often than a few times a second, as a page that is
      // being read out changes with every word.
      const now = Date.now();
      clearTimeout(enhancing);
      if (now - enhanced > 150) {
        enhanced = now;
        enhance(reading);
      } else {
        enhancing = setTimeout(() => { enhanced = Date.now(); enhance(reading); }, 150);
      }
    },

    setEditable(value) {
      editable = value;
      view.setProps({ editable: () => editable });
    },

    hasFocus: () => view.hasFocus(),

    focus: () => view.focus(),

    title: () => titleOf(editor.getMarkdown()),

    /** Runs a formatting command by name, keeping the cursor on the page. */
    run(name) {
      COMMANDS[name].run(view.state, view.dispatch);
      view.focus();
    },

    /** Whether the formatting `name` applies at the cursor. */
    active: (name) => COMMANDS[name].active(view.state),
  };
  return editor;
}
