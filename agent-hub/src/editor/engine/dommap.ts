/**
 * dommap.js — bridge browser Selection ↔ model (path, offset).
 *
 * Relies on render.js's `el.__bfNode` identity links + the view's nodeToPath /
 * domForNode maps, so it never counts sibling indices through wrapper elements.
 */
import { getNode } from './doc';
import type { DocNode } from '../model/schema.js';
import type { ModelPos } from './textIndex.js';

/** An element render.js produced: it links back to the model node it shows. */
export interface BfElement extends HTMLElement { __bfNode: DocNode }
export interface DomPoint { node: Node | null; offset: number }

/** Nearest ancestor block element (has __bfNode), or null. */
export function blockElFor(domNode: Node | null, host: Node | null): BfElement | null {
  let n: Node | null = domNode;
  while (n && n !== host) {
    if (n.nodeType === 1 && (n as BfElement).__bfNode) return n as BfElement;
    n = n.parentNode;
  }
  return null;
}

/** Browser (node, offset) → model { path, offset, atom? } or null. */
export function posFromDOM(host: Node, domNode: Node | null, domOffset: number, nodeToPath: Map<DocNode, number[]>): (ModelPos & { atom?: boolean }) | null {
  const blockEl = blockElFor(domNode, host);
  if (!blockEl) return null;
  const node = blockEl.__bfNode;
  const path = nodeToPath.get(node);
  if (!path) return null;
  if (blockEl.getAttribute('data-bf-atom') != null) return { path, offset: 0, atom: true };
  return { path, offset: tokenOffset(blockEl, domNode, domOffset) };
}

/** Model { path, offset } → browser { node, offset } or null. */
export function domFromPos(domForNode: WeakMap<DocNode, HTMLElement>, doc: DocNode, p: ModelPos): DomPoint | null {
  const node = getNode(doc, p.path);
  const blockEl = domForNode.get(node);
  if (!blockEl) return null;
  let remaining = p.offset;
  let result: DomPoint | null = null;
  const visit = (n: Node): void => {
    if (result) return;
    if (n.nodeType === 3) {
      if (remaining <= (n as Text).length) { result = { node: n, offset: remaining }; return; }
      remaining -= (n as Text).length; return;
    }
    if (n.nodeType === 1) {
      if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-filler') != null) return;
      if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-atom') != null) {
        if (remaining <= 0) { result = { node: n.parentNode, offset: indexOf(n) }; return; }
        remaining -= 1; return;
      }
      if ((n as Element).tagName === 'BR') {
        if (remaining <= 0) { result = { node: n.parentNode, offset: indexOf(n) }; return; }
        remaining -= 1; return;
      }
      for (const c of n.childNodes) { visit(c); if (result) return; }
    }
  };
  for (const c of blockEl.childNodes) { visit(c); if (result) break; }
  if (!result) {
    // Every token was consumed without a match, so the position is at the END
    // of the block. This used to return offset 0 when `remaining` landed on
    // exactly 0 — which happens for a caret sitting after a trailing atom or
    // <br> (Shift+Enter at the end of a paragraph, or inserting an inline
    // formula last). The caret was written to the START of the paragraph, and
    // since the DOM selection is read back into the model, the next character
    // typed went there too.
    const kids = blockEl.childNodes;
    let end = kids.length;
    // An empty block renders one filler <br>; the caret belongs before it.
    while (end > 0 && isFiller(kids[end - 1])) end -= 1;
    result = { node: blockEl, offset: end };
  }
  return result;
}

/* ── helpers ────────────────────────────────────────────── */

const isFiller = (n: Node): boolean => n && n.nodeType === 1 && (n as Element).getAttribute && (n as Element).getAttribute('data-bf-filler') != null;

function tokenOffset(blockEl: Element, target: Node | null, targetOffset: number): number {
  if (target === blockEl) {
    let c = 0;
    for (let i = 0; i < targetOffset && i < blockEl.childNodes.length; i++) c += tokensIn(blockEl.childNodes[i]);
    return c;
  }
  let count = 0;
  let done = false;
  const visit = (n: Node): void => {
    if (done) return;
    if (n === target) {
      if (n.nodeType === 3) count += targetOffset;
      else for (let i = 0; i < targetOffset && i < n.childNodes.length; i++) count += tokensIn(n.childNodes[i]);
      done = true; return;
    }
    if (n.nodeType === 3) { count += (n as Text).length; return; }
    if (n.nodeType === 1) {
      if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-filler') != null) return;
      if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-atom') != null) {
        // A selection landing INSIDE an atom's rendered DOM (node views render
        // real elements) must resolve to the atom's own token, not fall through
        // and accumulate the whole block — which mapped the caret to the end.
        if (n.contains && n.contains(target)) { done = true; return; }
        count += 1;
        return;
      }
      if ((n as Element).tagName === 'BR') { count += 1; return; }
      for (const c of n.childNodes) { visit(c); if (done) return; }
    }
  };
  for (const c of blockEl.childNodes) { visit(c); if (done) break; }
  return count;
}

function tokensIn(n: Node): number {
  if (n.nodeType === 3) return (n as Text).length;
  if (n.nodeType === 1) {
    if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-filler') != null) return 0;
    if ((n as Element).getAttribute && (n as Element).getAttribute('data-bf-atom') != null) return 1;
    if ((n as Element).tagName === 'BR') return 1;
    let c = 0;
    for (const ch of n.childNodes) c += tokensIn(ch);
    return c;
  }
  return 0;
}

function indexOf(node: Node): number {
  let i = 0;
  let s: Node | null = node;
  while ((s = s.previousSibling) != null) i++;
  return i;
}
