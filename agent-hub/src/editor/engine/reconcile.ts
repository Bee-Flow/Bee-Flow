/**
 * reconcile.js — incremental DOM patcher.
 *
 * Brings the contenteditable DOM to match a new doc with the MINIMUM mutation, so
 * that:
 *   - the text node the caret / IME / spellcheck lives in is preserved during
 *     typing (we patch its `.data`, never replace it), and
 *   - atom React portals are re-pointed (ctx.remapAtom) instead of unmounted on
 *     unrelated edits, so a mermaid/math view doesn't flicker or lose its state.
 *
 * Strategy: structural sharing (doc.js#updateAt) means an edit only re-creates the
 * node objects on the path from the doc root to the edit; every other subtree keeps
 * its object identity. So at each level we take the identity-common prefix and
 * suffix and only touch the small differing middle — pairing old↔new positionally
 * there to patch in place (same type/tag) or replace. Inline content has no stable
 * identity (it is rebuilt by tokensToInline), so it is diffed by value instead.
 *
 * Invariant maintained: a DOM element's `__bfNode` always references the node the
 * element currently reflects, and `ctx.domForNode` maps every block node in the new
 * doc to its element. `nodeToPath` is rebuilt globally by the caller each pass.
 */
import { renderBlock, renderInlineNode, updateAtomHost, type RenderCtx } from './render';
import { isTextblock, isAtom, isCode, type DocAttrs, type DocNode } from '../model/schema.js';
import { sameMarkSet } from '../model/marks.js';

/** Entry point: patch `parentEl`'s children from oldNodes → newNodes. */
export function reconcileChildren(parentEl: Element, oldNodes: DocNode[] | null | undefined, newNodes: DocNode[] | null | undefined, ctx: RenderCtx, basePath: number[]) {
  oldNodes = oldNodes || [];
  newNodes = newNodes || [];
  const domEls = elementChildren(parentEl);
  // If the DOM doesn't line up 1:1 with the old nodes (first pass after a full
  // render, or an external mutation), rebuild this level wholesale.
  if (domEls.length !== oldNodes.length) {
    Array.from(parentEl.childNodes).forEach((c) => unmountEl(c, ctx));
    parentEl.textContent = '';
    newNodes.forEach((n: DocNode, i: number) => parentEl.appendChild(renderBlock(n, ctx, [...basePath, i])));
    return;
  }
  // Identity-common prefix / suffix (unchanged subtrees: DOM already correct).
  let p = 0;
  while (p < oldNodes.length && p < newNodes.length && oldNodes[p] === newNodes[p]) p++;
  let so = oldNodes.length;
  let sn = newNodes.length;
  while (so > p && sn > p && oldNodes[so - 1] === newNodes[sn - 1]) { so--; sn--; }

  const midNew = newNodes.slice(p, sn);
  const midOldEls = domEls.slice(p, so);
  const suffixFirstEl = domEls[so] || null;

  let k = 0;
  for (; k < midNew.length; k++) {
    const newNode = midNew[k];
    if (k < midOldEls.length) {
      patchOrReplace(parentEl, midOldEls[k], newNode, ctx, [...basePath, p + k]);
    } else {
      parentEl.insertBefore(renderBlock(newNode, ctx, [...basePath, p + k]), suffixFirstEl);
    }
  }
  for (; k < midOldEls.length; k++) {
    unmountEl(midOldEls[k], ctx);
    parentEl.removeChild(midOldEls[k]);
  }
}

function patchOrReplace(parentEl: Element, el: HTMLElement, newNode: DocNode, ctx: RenderCtx, path: number[]) {
  const oldNode = el.__bfNode;
  if (oldNode === newNode) { ctx.domForNode && ctx.domForNode.set(newNode, el); return; }
  if (!sameTag(oldNode, newNode)) {
    const fresh = renderBlock(newNode, ctx, path);
    unmountEl(el, ctx);
    parentEl.replaceChild(fresh, el);
    return;
  }
  patchBlock(el, oldNode, newNode, ctx, path);
}

function patchBlock(el: HTMLElement, oldNode: DocNode | undefined, newNode: DocNode, ctx: RenderCtx, path: number[]) {
  el.__bfNode = newNode;
  ctx.domForNode && ctx.domForNode.set(newNode, el);
  patchBlockAttrs(el, newNode);
  const type = newNode.type;
  if (isAtom(type)) {
    el.__bfAtomNode = newNode;
    updateAtomHost(el, newNode);
    ctx.remapAtom && ctx.remapAtom(el, newNode);
    return;
  }
  if (isCode(type)) {
    const code = el.querySelector('code') || el;
    const txt = (newNode.content || []).map((c) => c.text || '').join('') || '​';
    if (code.textContent !== txt) code.textContent = txt;
    return;
  }
  if (isTextblock(type)) {
    patchInline(el, (oldNode as DocNode).content || [], newNode.content || [], ctx);
    return;
  }
  reconcileChildren(childContainer(el, type), (oldNode as DocNode).content || [], newNode.content || [], ctx, path);
}

/* ── inline (textblock) patching ────────────────────────── */

function patchInline(blockEl: Element, oldInline: DocNode[], newInline: DocNode[], ctx: RenderCtx) {
  const d = blockEl.ownerDocument;
  const filler = blockEl.querySelector(':scope > br[data-bf-filler]');
  if (filler) blockEl.removeChild(filler);

  if (newInline.length === 0) {
    Array.from(blockEl.childNodes).forEach((c) => unmountEl(c, ctx));
    blockEl.textContent = '';
    const br = d.createElement('br');
    br.setAttribute('data-bf-filler', '');
    blockEl.appendChild(br);
    return;
  }

  const domNodes = Array.from(blockEl.childNodes);
  if (domNodes.length !== oldInline.length) {
    Array.from(blockEl.childNodes).forEach((c) => unmountEl(c, ctx));
    blockEl.textContent = '';
    newInline.forEach((n) => blockEl.appendChild(renderInlineNode(n, ctx)));
    return;
  }

  let p = 0;
  while (p < oldInline.length && p < newInline.length && inlineEq(oldInline[p], newInline[p])) p++;
  let so = oldInline.length;
  let sn = newInline.length;
  while (so > p && sn > p && inlineEq(oldInline[so - 1], newInline[sn - 1])) { so--; sn--; }

  const midNew = newInline.slice(p, sn);
  const midDom = domNodes.slice(p, so);
  const suffixFirst = domNodes[so] || null;

  let k = 0;
  for (; k < midNew.length; k++) {
    const nn = midNew[k];
    if (k < midDom.length) {
      const dom = midDom[k];
      const on = oldInline[p + k];
      if (inlineSameShape(on, nn)) {
        patchInlineNode(dom, nn, ctx);
      } else {
        if (isInlineAtom(on)) unmountEl(dom, ctx);
        blockEl.replaceChild(renderInlineNode(nn, ctx), dom);
      }
    } else {
      blockEl.insertBefore(renderInlineNode(nn, ctx), suffixFirst);
    }
  }
  for (; k < midDom.length; k++) {
    if (isInlineAtom(oldInline[p + k])) unmountEl(midDom[k], ctx);
    blockEl.removeChild(midDom[k]);
  }
}

function patchInlineNode(dom: ChildNode, nn: DocNode, ctx: RenderCtx) {
  if (nn.type === 'text') {
    const t = innermostText(dom);
    if (t && t.data !== nn.text) t.data = nn.text as string; // preserve the text node → stable caret/IME
    return;
  }
  if (nn.type === 'mathInline' || nn.type === 'image' || nn.type === 'formula') {
    dom.__bfAtomNode = nn;
    updateAtomHost(dom as Element, nn);
    ctx.remapAtom && ctx.remapAtom(dom as Element, nn);
  }
  // hardBreak: nothing to patch.
}

/* ── attribute patching ─────────────────────────────────── */

function patchBlockAttrs(el: HTMLElement, node: DocNode) {
  const a = <K extends keyof DocAttrs>(k: K): DocAttrs[K] | null => node.attrs?.[k] ?? null;
  switch (node.type) {
    case 'paragraph':
    case 'heading': {
      const al = a('align');
      if (al === 'center' || al === 'right') el.style.textAlign = al;
      else el.style.removeProperty('text-align');
      break;
    }
    case 'orderedList': {
      const s = a('start');
      if (s && s !== 1) el.setAttribute('start', String(s)); else el.removeAttribute('start');
      break;
    }
    case 'taskItem': {
      const checked = !!a('checked');
      el.setAttribute('data-checked', checked ? 'true' : 'false');
      const box = el.querySelector<HTMLInputElement>('input[data-bf-checkbox]');
      if (box) box.checked = checked;
      break;
    }
    case 'tableCell': {
      const al = a('align');
      if (al) el.style.textAlign = al; else el.style.removeProperty('text-align');
      const cs = a('colspan'); if (cs && cs !== 1) el.setAttribute('colspan', String(cs)); else el.removeAttribute('colspan');
      const rs = a('rowspan'); if (rs && rs !== 1) el.setAttribute('rowspan', String(rs)); else el.removeAttribute('rowspan');
      const cw = a('colwidth'); if (cw) el.style.width = `${cw}px`; else el.style.removeProperty('width');
      break;
    }
    default: break;
  }
}

/* ── helpers ────────────────────────────────────────────── */

function elementChildren(parentEl: Element) {
  return Array.from(parentEl.children).filter((c) => c.__bfNode) as HTMLElement[];
}

function childContainer(el: Element, type: string) {
  if (type === 'table') return el.querySelector(':scope > tbody') || el;
  if (type === 'taskItem') return el.lastElementChild || el; // <li><label/><div>children</div></li>
  return el;
}

function sameTag(a: DocNode | undefined, b: DocNode | undefined) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'heading') return (a.attrs?.level || 1) === (b.attrs?.level || 1);
  if (a.type === 'tableCell') return !!(a.attrs?.header) === !!(b.attrs?.header);
  return true;
}

const isInlineAtom = (n: DocNode | undefined) => n && (n.type === 'mathInline' || n.type === 'image' || n.type === 'formula');

function inlineEq(a: DocNode | undefined, b: DocNode | undefined) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'text') return a.text === b.text && sameMarkSet(a.marks || [], b.marks || []);
  if (a.type === 'hardBreak') return true;
  return shallowAttrsEq(a.attrs, b.attrs); // inline atoms
}

function inlineSameShape(a: DocNode | undefined, b: DocNode | undefined) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'text') return sameMarkSet(a.marks || [], b.marks || []);
  return true; // same-type atom / hardBreak → patch in place
}

function shallowAttrsEq(a: DocAttrs | undefined = {}, b: DocAttrs | undefined = {}) {
  a = a || {}; b = b || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function innermostText(dom: ChildNode) {
  let n: ChildNode | null = dom;
  while (n && n.nodeType === 1) n = n.firstChild;
  return n && n.nodeType === 3 ? (n as Text) : null;
}

function unmountEl(el: Element | ChildNode, ctx: RenderCtx) {
  if (!ctx.unmountAtom || !el || el.nodeType !== 1) return;
  if ((el as Element).getAttribute && (el as Element).getAttribute('data-bf-atom') != null && el.__bfAtomNode) ctx.unmountAtom(el as Element);
  (el as Element).querySelectorAll && (el as Element).querySelectorAll('[data-bf-atom]').forEach((a) => a.__bfAtomNode && (ctx.unmountAtom as (el: Element) => void)(a));
}
