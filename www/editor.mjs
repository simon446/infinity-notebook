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
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

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
  // Links open in a new tab and tell the site nothing about this page.
  marks: markdownSchema.spec.marks.update("link", {
    ...markdownSchema.spec.marks.get("link"),
    toDOM: (mark) => ["a", { ...mark.attrs, target: "_blank", rel: "noopener noreferrer nofollow" }],
  }),
});

// A line break in the text is a line break on the page, both ways. (Plain
// Markdown would join the lines and write a break as a backslash.)
//
// Addresses written out with their scheme (https://...) are links without any
// Markdown around them.
const markdownIt = MarkdownIt("commonmark", { html: false, linkify: true }).enable("linkify").disable("image");
const linkify = markdownIt.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

const { image: _imageToken, ...tokens } = defaultMarkdownParser.tokens;
const parser = new MarkdownParser(schema, markdownIt, {
  ...tokens,
  softbreak: { node: "hard_break" },
});

/** The link `text` is on its own, if all of it is one address. */
function addressOf(text) {
  const matches = linkify.match(text);
  if (matches?.length === 1 && matches[0].index === 0 && matches[0].lastIndex === text.length) return matches[0].url;
  return undefined;
}

/** True for a link that is just its address, which is written without brackets. */
function isBareAddress(link, parent, index) {
  const content = parent.child(index);
  return (
    !link.attrs.title &&
    content.isText &&
    content.marks[content.marks.length - 1] === link &&
    (index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks)) &&
    addressOf(content.text) === link.attrs.href
  );
}

const defaultLink = defaultMarkdownSerializer.marks.link;

const { image: _imageNode, ...nodes } = defaultMarkdownSerializer.nodes;
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
  {
    ...defaultMarkdownSerializer.marks,
    link: {
      ...defaultLink,
      open(state, mark, parent, index) {
        state.bareAddress = isBareAddress(mark, parent, index);
        if (!state.bareAddress) return defaultLink.open(state, mark, parent, index);
        state.inAutolink = true; // the address is written as it is, unescaped
        return "";
      },
      close(state, mark, parent, index) {
        if (!state.bareAddress) return defaultLink.close(state, mark, parent, index);
        state.bareAddress = state.inAutolink = undefined;
        return "";
      },
    },
  }
);

const parse = (markdown) => parser.parse(markdown) ?? schema.topNodeType.createAndFill();
const serialize = (doc) => serializer.serialize(doc);

/** The Markdown that `markdown` turns into once it has been on the page. */
export function canonical(markdown) {
  return serialize(parse(markdown));
}

/**
 * Keeps addresses linked while typing: every address in the text is a link,
 * and a link that was made this way goes away when its text stops being one.
 * Links with a text of their own, as in [text](address), are left alone.
 */
const linkAddresses = new Plugin({
  appendTransaction(transactions, _before, state) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null;
    const { link, code } = schema.marks;
    const transaction = state.tr;
    state.doc.descendants((block, blockStart) => {
      if (!block.isTextblock) return true;
      if (block.type.spec.code) return false;
      // The block's text, with a placeholder for anything that is not text,
      // so that offsets in it are offsets in the block.
      const text = block.textBetween(0, block.content.size, undefined, "\ufffc");
      const from = blockStart + 1;
      const addresses = (linkify.match(text) ?? []).filter(
        (match) => !state.doc.rangeHasMark(from + match.index, from + match.lastIndex, code)
      );

      // Drop links that are an address no longer found where they are.
      let offset = 0;
      block.forEach((child) => {
        const mark = link.isInSet(child.marks);
        const [start, end] = [offset, offset + child.nodeSize];
        offset = end;
        if (!mark || !child.isText || mark.attrs.title || addressOf(child.text) !== mark.attrs.href) return;
        if (!addresses.some((match) => match.index === start && match.lastIndex === end && match.url === mark.attrs.href)) {
          transaction.removeMark(from + start, from + end, link);
        }
      });

      for (const match of addresses) {
        const [start, end] = [from + match.index, from + match.lastIndex];
        let linked = true;
        let other = false;
        state.doc.nodesBetween(start, end, (node) => {
          if (!node.isInline) return;
          const mark = link.isInSet(node.marks);
          if (!mark) linked = false;
          else if (mark.attrs.href !== match.url) other = true;
        });
        if (other) transaction.removeMark(start, end, link);
        if (other || !linked) transaction.addMark(start, end, link.create({ href: match.url }));
      }
      return false;
    });
    return transaction.docChanged ? transaction : null;
  },
});

/** Opens the link under a click or tap, if it leads somewhere ordinary. */
function openLink(_view, _position, event) {
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
          keymap({ "Mod-Enter": () => (onSubmit(), true) }),
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

    /** Runs a formatting command by name, keeping the cursor on the page. */
    run(name) {
      COMMANDS[name].run(view.state, view.dispatch);
      view.focus();
    },

    /** Whether the formatting `name` applies at the cursor. */
    active: (name) => COMMANDS[name].active(view.state),
  };
}
