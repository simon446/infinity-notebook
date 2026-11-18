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
import { EditorState } from "prosemirror-state";
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
  marks: markdownSchema.spec.marks,
});

// A line break in the text is a line break on the page, both ways. (Plain
// Markdown would join the lines and write a break as a backslash.)
const { image: _imageToken, ...tokens } = defaultMarkdownParser.tokens;
const parser = new MarkdownParser(schema, MarkdownIt("commonmark", { html: false }).disable("image"), {
  ...tokens,
  softbreak: { node: "hard_break" },
});

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
  defaultMarkdownSerializer.marks
);

const parse = (markdown) => parser.parse(markdown) ?? schema.topNodeType.createAndFill();
const serialize = (doc) => serializer.serialize(doc);

/** The Markdown that `markdown` turns into once it has been on the page. */
export function canonical(markdown) {
  return serialize(parse(markdown));
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
        ],
      }),
      editable: () => editable,
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
