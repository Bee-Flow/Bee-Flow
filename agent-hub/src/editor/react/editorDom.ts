/** DOM selection geometry and text for the editor chrome (bubbles, link editor, AI actions). */

export function selectionText(view: any): string {
  if (!view) return '';
  const sel = view.state.selection;
  if (sel.type !== 'text') return '';
  const dsel = window.getSelection();
  return dsel ? dsel.toString() : '';
}

/** Screen box of the DOM selection (anchors the link bubble and editor). */
export function selectionRect(): { top: number; left: number; bottom: number } | null {
  try {
    const dsel = window.getSelection();
    if (!dsel || !dsel.rangeCount) return null;
    const r = dsel.getRangeAt(0).getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0)) return null;
    return { top: r.top, left: r.left, bottom: r.bottom };
  } catch (e) {
    return null;
  }
}

/**
 * Where to anchor a popover when the selection has no box of its own (a caret
 * on an empty line, or an engine without Range geometry): the current block,
 * else the top of the editor.
 */
export function blockRect(view: any): { top: number; left: number; bottom: number } {
  try {
    const block = view.currentBlock?.();
    const el = (block && view.domForNode.get(block)) || view.host;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: el === view.host ? r.top + 24 : r.bottom };
  } catch {
    return { top: 120, left: 120, bottom: 144 };
  }
}
