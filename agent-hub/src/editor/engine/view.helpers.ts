import { isTextblock, type DocNode } from '../model/schema.js';
import { inlineToTokens } from './inline.js';
import * as T from './transforms.js';
import type { AtomNode, AtomResolution } from './view.types';

export const now = () => (typeof Date !== 'undefined' ? Date.now() : 0);

/** Remember the scroll offsets of `el` and its ancestors; the returned function puts them back. */
export function keepScroll(el: HTMLDivElement) {
  const saved: [HTMLElement, number, number][] = [];
  for (let n: HTMLElement | null = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.scrollTop || n.scrollLeft) saved.push([n, n.scrollTop, n.scrollLeft]);
  }
  return () => {
    for (const [n, top, left] of saved) {
      if (n.scrollTop !== top) n.scrollTop = top;
      if (n.scrollLeft !== left) n.scrollLeft = left;
    }
  };
}

/** Plain text of a doc AST, one line per textblock (hard breaks become newlines). */
export function docToText(doc: DocNode) {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (isTextblock(n.type)) {
      out.push(inlineToTokens(n.content)
        .map((t) => (t.node ? (t.node.type === 'hardBreak' ? '\n' : '') : t.ch))
        .join(''));
      return;
    }
    (n.content || []).forEach(walk);
  };
  (doc.content || []).forEach(walk);
  return out.join('\n');
}

/** Find where an atom lives: by identity (block atoms by path, inline atoms by position), else by a same-type hint. */
export function resolveAtomIn(nodeToPath: Map<DocNode, number[]>, doc: DocNode, node: AtomNode | null, fallbackAt: { path: number[]; offset: number } | null): AtomResolution | null {
  const path = nodeToPath.get(node as DocNode);
  if (path) return { inline: false, path };
  const at = T.findInlineNode(doc, node as DocNode | null);
  if (at) return { inline: true, path: at.path, offset: at.offset };
  // Identity miss — the node-view's `node` prop can go stale (a recompute
  // replaced the atom object while its editor was open). When the caller
  // captured a {path, offset} hint, accept it iff a same-type inline node
  // still sits at that position.
  if (fallbackAt && Array.isArray(fallbackAt.path) && typeof fallbackAt.offset === 'number') {
    let block: DocNode | null = doc;
    for (const i of fallbackAt.path) { block = block && block.content ? block.content[i] : null; }
    if (block && isTextblock(block.type)) {
      const tok = inlineToTokens(block.content)[fallbackAt.offset];
      if (tok?.node && tok.node.type === node?.type) return { inline: true, path: fallbackAt.path, offset: fallbackAt.offset };
    }
  }
  return null;
}
