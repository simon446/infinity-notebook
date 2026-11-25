// The page as rich text. What is edited is a ProseMirror document; what the
// notebook stores, searches for and numbers is that document as Markdown.

import MarkdownIt from "markdown-it";
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { exampleSetup } from "prosemirror-example-setup";
import { keymap } from "prosemirror-keymap";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  schema as markdownSchema,
} from "prosemirror-markdown";
import { Schema } from "prosemirror-model";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";

// The Markdown schema without images: a page is text, and a random page
// should not make the browser fetch whatever address it happens to name.
// New lists are tight: one item per line, without blank lines in between.
const tightByDefault = (name) => {
  const spec = markdownSchema.spec.nodes.get(name);
  return { ...spec, attrs: { ...spec.attrs, tight: { default: true } } };
};

const schema = new Schema({
  nodes: markdownSchema.spec.nodes
    .remove("image")
    .update("heading", { ...markdownSchema.spec.nodes.get("heading"), content: "inline*" })
    .update("bullet_list", tightByDefault("bullet_list"))
    .update("ordered_list", tightByDefault("ordered_list")),
  // No links either. An address in the text is shown as a link (see
  // linkAddresses), but the text itself stays plain: what you type is what
  // the page holds.
  marks: markdownSchema.spec.marks.remove("link"),
});

// A line break in the text is a line break on the page, both ways. (Plain
// Markdown would join the lines and write a break as a backslash.) With no
// links, [text](address) and <address> are ordinary text.
const markdownIt = MarkdownIt("commonmark", { html: false }).disable(["image", "link", "autolink"]);
// Only addresses written out with their scheme (https://...) count as links.
const linkify = markdownIt.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

const { image: _imageToken, link: _linkToken, ...tokens } = defaultMarkdownParser.tokens;
const parser = new MarkdownParser(schema, markdownIt, {
  ...tokens,
  softbreak: { node: "hard_break" },
});

const { image: _imageNode, ...nodes } = defaultMarkdownSerializer.nodes;
const { link: _linkMark, ...marks } = defaultMarkdownSerializer.marks;
const serializer = new MarkdownSerializer(
  {
    ...nodes,
    hard_break(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\n");
          return;
        }
      }
    },
  },
  marks
);

const parse = (markdown) => parser.parse(markdown) ?? schema.topNodeType.createAndFill();
const serialize = (doc) => serializer.serialize(doc);

/** The Markdown that `markdown` turns into once it has been on the page. */
export function canonical(markdown) {
  return serialize(parse(markdown));
}

/** Draws every address in the text as a link, without changing the text. */
function findAddresses(doc) {
  const links = [];
  doc.descendants((block, blockStart) => {
    if (!block.isTextblock) return true;
    if (block.type.spec.code) return false;
    // The block's text, with a line break standing in for anything that is
    // not text (which is a line break). Offsets in it are then offsets in
    // the block, and an address ends where its line does.
    const text = block.textBetween(0, block.content.size, undefined, "\n");
    const from = blockStart + 1;
    for (const match of linkify.match(text) ?? []) {
      const [start, end] = [from + match.index, from + match.lastIndex];
      if (doc.rangeHasMark(start, end, schema.marks.code)) continue;
      links.push(Decoration.inline(start, end, {
        nodeName: "a",
        href: match.url,
        // Open in a new tab, and tell the site nothing about this page.
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, links);
}

const linkAddresses = new Plugin({
  state: {
    init: (_config, state) => findAddresses(state.doc),
    apply: (transaction, links) => (transaction.docChanged ? findAddresses(transaction.doc) : links),
  },
  props: {
    decorations(state) {
      return linkAddresses.getState(state);
    },
  },
});

/**
 * Opens the link under a click or tap while the page is being edited. (A page
 * that is only being read has ordinary links, which the browser opens.)
 */
function openLink(view, _position, event) {
  if (!view.editable) return false;
  const anchor = event.target.closest?.("a[href]");
  if (!anchor || event.button !== 0) return false;
  let address;
  try {
    address = new URL(anchor.getAttribute("href"), window.location.href);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(address.protocol)) return false;
  window.open(address.href, "_blank", "noopener,noreferrer");
  return true;
}

/** True if the selection is inside a node of this type (with these attributes). */
function inside(state, type, attrs) {
  const { $from, to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === type && (!attrs || Object.keys(attrs).every((key) => node.attrs[key] === attrs[key]))) {
      return to <= $from.end(depth);
    }
  }
  return false;
}

function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** A formatting button: what it does and whether it is on at the cursor. */
function mark(type) {
  return { run: toggleMark(type), active: (state) => markActive(state, type) };
}

function block(type, attrs) {
  const active = (state) => inside(state, type, attrs);
  return {
    run: (state, dispatch) => (active(state) ? setBlockType(schema.nodes.paragraph) : setBlockType(type, attrs))(state, dispatch),
    active,
  };
}

function wrapper(type, wrap, unwrap) {
  const active = (state) => inside(state, type);
  return { run: (state, dispatch) => (active(state) ? unwrap : wrap)(state, dispatch), active };
}

const COMMANDS = {
  strong: mark(schema.marks.strong),
  em: mark(schema.marks.em),
  heading1: block(schema.nodes.heading, { level: 1 }),
  heading2: block(schema.nodes.heading, { level: 2 }),
  bullet_list: wrapper(schema.nodes.bullet_list, wrapInList(schema.nodes.bullet_list), liftListItem(schema.nodes.list_item)),
  ordered_list: wrapper(schema.nodes.ordered_list, wrapInList(schema.nodes.ordered_list), liftListItem(schema.nodes.list_item)),
  blockquote: wrapper(schema.nodes.blockquote, wrapIn(schema.nodes.blockquote), lift),
};

/**
 * Turns `mount` into the page.
 * @param onEdit called after the person changed the page
 * @param onSubmit called when they press Ctrl/Cmd + Enter
 * @param onState called after every change of text or cursor
 */
export function createEditor(mount, { onEdit, onSubmit, onState }) {
  let editable = true;
  const view = new EditorView(
    { mount },
    {
      state: EditorState.create({
        schema,
        plugins: [
          keymap({
            "Mod-Enter": () => (onSubmit(), true),
            // In a list, Tab moves the item a level in and Shift + Tab back out.
            Tab: sinkListItem(schema.nodes.list_item),
            "Shift-Tab": liftListItem(schema.nodes.list_item),
          }),
          ...exampleSetup({ schema, menuBar: false }),
          linkAddresses,
        ],
      }),
      editable: () => editable,
      handleClick: openLink,
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction));
        if (transaction.docChanged && !transaction.getMeta("written")) onEdit();
        onState();
      },
    }
  );

  return {
    getMarkdown: () => serialize(view.state.doc),

    /** Puts `markdown` on the page, touching only what differs from what is there. */
    setMarkdown(markdown) {
      const before = view.state.doc;
      const after = parse(markdown);
      const start = before.content.findDiffStart(after.content);
      if (start === null) return;
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
    },

    setEditable(value) {
      editable = value;
      view.setProps({ editable: () => editable });
    },

    hasFocus: () => view.hasFocus(),

    focus: () => view.focus(),

    /** The page's first large heading, if it has one. */
    title() {
      let title;
      view.state.doc.forEach((node) => {
        if (title === undefined && node.type === schema.nodes.heading && node.attrs.level === 1) title = node.textContent.trim();
      });
      return title;
    },

    /** Runs a formatting command by name, keeping the cursor on the page. */
    run(name) {
      COMMANDS[name].run(view.state, view.dispatch);
      view.focus();
    },

    /** Whether the formatting `name` applies at the cursor. */
    active: (name) => COMMANDS[name].active(view.state),
  };
}
