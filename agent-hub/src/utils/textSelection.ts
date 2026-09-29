/**
 * Map a DOM selection boundary back to a character offset in the text a
 * container renders.
 *
 * Works for any renderer that draws its text as consecutive runs (plain
 * spans and highlighted marks) with no characters added or removed: a
 * TreeWalker over the container's text nodes then reconstructs exactly the
 * offsets the text was built from. Shared by the DLP review highlighter and
 * the Privacy Shield test bench, which mark text the same way.
 */
export function textOffsetFromPoint(container: Node, node: Node, nodeOffset: number): number {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let total = 0;
    let n = walker.nextNode();
    while (n) {
        if (n === node) return total + nodeOffset;
        total += (n.textContent || '').length;
        n = walker.nextNode();
    }
    // Boundary landed on an element rather than inside a text node (e.g. the
    // very end of the container): the walked length so far is correct then.
    return total;
}

/**
 * The current window selection as `{ start, end }` inside `container`, or
 * null when there is none, it is collapsed, or it starts or ends outside it.
 */
export function selectionOffsetsIn(container: Node | null): { start: number; end: number } | null {
    if (!container || typeof window === 'undefined') return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    const a = textOffsetFromPoint(container, range.startContainer, range.startOffset);
    const b = textOffsetFromPoint(container, range.endContainer, range.endOffset);
    if (a === b) return null;
    return { start: Math.min(a, b), end: Math.max(a, b) };
}
