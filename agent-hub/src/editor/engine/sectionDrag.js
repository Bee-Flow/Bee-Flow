/**
 * sectionDrag.js — heading-aware block move (ports SectionDragExtension).
 *
 * Dragging a heading moves the whole section (the heading + every following
 * top-level block until the next heading of equal-or-higher level). Non-heading
 * blocks move alone. Operates on the top-level block array — simpler than the old
 * ProseMirror appendTransaction/slice patching.
 */
import { textSelection, pos } from './selection.js';

export function getSectionRange(doc, idx) {
  const blocks = doc.content || [];
  const node = blocks[idx];
  if (!node || node.type !== 'heading') return 1;
  const level = node.attrs?.level || 1;
  let count = 1;
  for (let i = idx + 1; i < blocks.length; i++) {
    const n = blocks[i];
    if (n.type === 'heading' && (n.attrs?.level || 1) <= level) break;
    count++;
  }
  return count;
}

/** Move `count` top-level blocks starting at `fromIdx` to before original index `toIdx`. */
export function moveBlocks(state, fromIdx, count, toIdx) {
  if (toIdx >= fromIdx && toIdx < fromIdx + count) return state; // dropping inside the source
  const blocks = (state.doc.content || []).slice();
  const moving = blocks.splice(fromIdx, count);
  const insertAt = Math.max(0, Math.min(toIdx > fromIdx ? toIdx - count : toIdx, blocks.length));
  blocks.splice(insertAt, 0, ...moving);
  return { doc: { ...state.doc, content: blocks }, selection: textSelection(pos([insertAt], 0)), storedMarks: null };
}

/**
 * Where `blocks` (top-level blocks captured when a drag started) sit in `doc`
 * now, as one run: the index of the first, or -1 when they are gone, changed
 * or no longer together. The run at `hint` (where they were) is tried first,
 * otherwise the nearest one wins. Identity settles an unchanged document; a
 * co-editor's change copies every block, so they are also compared by value.
 */
export function findBlocks(doc, blocks, hint) {
  const content = doc.content || [];
  const n = blocks.length;
  if (!n) return -1;
  const keys = new Map();
  const key = (node) => {
    if (!keys.has(node)) keys.set(node, JSON.stringify(node));
    return keys.get(node);
  };
  const runAt = (i) => {
    for (let k = 0; k < n; k++) {
      const node = content[i + k];
      if (!node || (node !== blocks[k] && key(node) !== key(blocks[k]))) return false;
    }
    return true;
  };
  if (hint >= 0 && runAt(hint)) return hint;
  let best = -1;
  for (let i = 0; i + n <= content.length; i++) {
    if (runAt(i) && (best < 0 || Math.abs(i - hint) < Math.abs(best - hint))) best = i;
  }
  return best;
}
