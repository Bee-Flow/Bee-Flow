/**
 * commands/index.js — command registry.
 *
 * Each command is a factory `(...args) => (state) => state`. The view's chain()
 * shim composes them so `editor.chain().focus().toggleBold().run()` ports from
 * the existing toolbar JSX with only the import changed. View-level commands
 * (focus, undo, redo, setContent, *Markdown) are handled in view.js.
 */
import * as T from '../engine/transforms.js';
import * as Tbl from '../engine/tables';
import { markdownToAst } from '../serialization/mdToAst';
import { htmlToAst } from '../serialization/htmlToAst';
import { looksLikeHtml } from '../serialization/util';
import type { DocAttrs, DocNode } from '../model/schema.js';
import type { EditorState } from '../engine/state.js';

/** What insertContent accepts: Markdown/HTML text, a node, a list of nodes, or a doc. */
export type InsertableContent = string | DocNode | DocNode[] | null | undefined;

const id = (s: EditorState): EditorState => s;

export const commands = {
  /* marks */
  toggleBold: () => (s: EditorState) => T.toggleMark(s, 'bold'),
  toggleItalic: () => (s: EditorState) => T.toggleMark(s, 'italic'),
  toggleUnderline: () => (s: EditorState) => T.toggleMark(s, 'underline'),
  toggleStrike: () => (s: EditorState) => T.toggleMark(s, 'strike'),
  toggleCode: () => (s: EditorState) => T.toggleMark(s, 'code'),
  toggleHighlight: (attrs?: { color?: string }) => (s: EditorState) => (attrs?.color ? T.setMark(s, 'highlight', { color: attrs.color }) : T.toggleMark(s, 'highlight')),
  setColor: (color: string) => (s: EditorState) => T.setMarkAttrs(s, 'textStyle', { color }),
  unsetColor: () => (s: EditorState) => T.setMarkAttrs(s, 'textStyle', { color: null }),
  setFontFamily: (fontFamily: string) => (s: EditorState) => T.setMarkAttrs(s, 'textStyle', { fontFamily }),
  unsetFontFamily: () => (s: EditorState) => T.setMarkAttrs(s, 'textStyle', { fontFamily: null }),
  setLink: (attrs?: { href?: string }) => (s: EditorState) => T.setMark(s, 'link', { href: attrs?.href || '' }),
  unsetLink: () => (s: EditorState) => T.unsetMark(s, 'link'),

  /* blocks */
  setParagraph: () => (s: EditorState) => T.setBlockType(s, 'paragraph'),
  toggleHeading: (attrs?: { level?: number }) => (s: EditorState) => T.toggleBlockType(s, 'heading', { level: attrs?.level || 1 }),
  setHeading: (attrs?: { level?: number }) => (s: EditorState) => T.setBlockType(s, 'heading', { level: attrs?.level || 1 }),
  toggleBulletList: () => (s: EditorState) => T.toggleList(s, 'bulletList'),
  toggleOrderedList: () => (s: EditorState) => T.toggleList(s, 'orderedList'),
  toggleTaskList: () => (s: EditorState) => T.toggleList(s, 'taskList'),
  toggleBlockquote: () => (s: EditorState) => T.toggleBlockquote(s),
  setCodeBlock: () => (s: EditorState) => T.setBlockType(s, 'codeBlock'),
  setTextAlign: (align: string) => (s: EditorState) => T.setTextAlign(s, align),
  sinkListItem: () => (s: EditorState) => T.sinkListItem(s),
  liftListItem: () => (s: EditorState) => T.liftListItem(s),

  /* atoms */
  setImage: (attrs: DocAttrs) => (s: EditorState) => T.insertBlockNode(s, { type: 'image', attrs }),
  insertMermaid: (code: string) => (s: EditorState) => T.insertBlockNode(s, { type: 'mermaid', attrs: { code } }),
  insertMermaidDiagram: (code: string) => (s: EditorState) => T.insertBlockNode(s, { type: 'mermaid', attrs: { code } }),
  insertHorizontalRule: () => (s: EditorState) => T.insertBlockNode(s, { type: 'horizontalRule' }),
  setHorizontalRule: () => (s: EditorState) => T.insertBlockNode(s, { type: 'horizontalRule' }),
  insertInlineNode: (inlineNode: DocNode) => (s: EditorState) => T.insertInlineNode(s, inlineNode),
  updateAttributes: (_name: string, attrs: DocAttrs) => (s: EditorState) => T.updateNodeAttrs(s, attrs),

  /* tables */
  insertTable: (opts?: { rows?: number; cols?: number; withHeaderRow?: boolean }) => (s: EditorState) => T.insertBlockNode(s, Tbl.makeTable(opts?.rows || 3, opts?.cols || 3, opts?.withHeaderRow !== false)),
  addRowAfter: () => Tbl.addRowAfter,
  addRowBefore: () => Tbl.addRowBefore,
  addColumnAfter: () => Tbl.addColumnAfter,
  addColumnBefore: () => Tbl.addColumnBefore,
  appendRow: () => Tbl.appendRow,
  appendColumn: () => Tbl.appendColumn,
  toggleHeaderRow: () => Tbl.toggleHeaderRow,
  setCellFormula: (src: string) => (s: EditorState) => Tbl.setCellFormula(s, src),
  addColumnTotal: (tablePath: number[], col: number) => (s: EditorState) => Tbl.addColumnTotal(s, tablePath, col),
  insertAfterTable: (blockNode: DocNode) => (s: EditorState) => Tbl.insertAfterTable(s, blockNode),
  deleteRow: () => Tbl.deleteRow,
  deleteColumn: () => Tbl.deleteColumn,
  deleteTable: () => Tbl.deleteTable,
  setCellAlign: (align: string) => (s: EditorState) => Tbl.setCellAlign(s, align),
  clearCells: () => (s: EditorState) => Tbl.clearCells(s),
  setColumnWidth: (colIdx: number, width: number) => (s: EditorState) => Tbl.setColumnWidth(s, colIdx, width),

  /* generic */
  deleteSelection: () => (s: EditorState) => T.deleteSelection(s),
  deleteBackward: () => (s: EditorState) => T.deleteBackward(s),
  insertContent: (content: InsertableContent) => (s: EditorState) => insertContentCmd(s, content),
  insertText: (text: string) => (s: EditorState) => T.insertText(s, text),
  focus: () => id,
  run: () => id,
};

/**
 * Insert content at the caret, replacing the selection.
 *
 * The single-textblock case goes through insertInline so a couple of pasted
 * words land AT the caret. `onPaste` used to call T.insertBlocks directly for
 * the text/html branch, which ignores the caret offset entirely and appends a
 * new block after the current one — so pasting two styled words from Word into
 * the middle of a sentence created a new paragraph below it, and pasting over a
 * selection kept the original.
 */
export function insertContentCmd(state: EditorState, content: InsertableContent): EditorState {
  if (content == null) return state;
  // Replace the selection first; every branch below inserts at the caret.
  const s0 = T.isTextRange(state) ? T.deleteSelection(state) : state;
  if (typeof content === 'string') {
    // DOCX import and "insert to document" pass HTML; parsing it as Markdown
    // rendered the tags as literal text (TipTap-era assumption).
    const ast = looksLikeHtml(content) ? htmlToAst(content) : markdownToAst(content);
    return insertBlocksOrInline(s0, ast.content || []);
  }
  if (Array.isArray(content)) return insertBlocksOrInline(s0, content);
  if (content.type === 'doc') return insertBlocksOrInline(s0, content.content || []);
  // single node
  if (content.type !== 'paragraph' && content.type !== 'text') {
    return content.content ? T.insertBlocks(s0, [content]) : T.insertBlockNode(s0, content);
  }
  return content.type === 'paragraph' ? T.insertInline(s0, content.content || []) : T.insertInline(s0, [content]);
}

/**
 * One paragraph pastes inline (at the caret); anything else pastes as blocks.
 * Paragraph only — not any textblock: a lone heading/code block routed through
 * the inline path was flattened into the current paragraph, losing its type.
 */
function insertBlocksOrInline(state: EditorState, blocks: DocNode[]): EditorState {
  if (blocks.length === 1 && blocks[0].type === 'paragraph') return T.insertInline(state, blocks[0].content || []);
  return T.insertBlocks(state, blocks);
}
