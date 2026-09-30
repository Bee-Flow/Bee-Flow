/**
 * ySync.ts — write a new BeeEditor document into a shared fragment with the
 * smallest set of Yjs operations, so concurrent work of others survives.
 *
 * The idea is y-prosemirror's `updateYFragment`, ported to this AST:
 *   - children are matched against the last document the local side saw
 *     (the cache's base) by identity first, then by "would be stored
 *     identically" (sameInY). Unchanged subtrees cost nothing and are never
 *     rewritten, even when someone else has changed them since;
 *   - in a changed stretch, blocks of the same kind are paired by similarity
 *     and updated in place; the rest is deleted or inserted;
 *   - a textblock is updated per token (character or inline atom): formatting
 *     changes are `format` calls, text changes the smallest splices, atom
 *     attribute changes `setAttribute` on the embedded element; a retype
 *     (paragraph ↔ heading ↔ code) is an attribute change;
 *   - with a base, local edits are carried onto the current shared text
 *     (diff/merge3.ts), so text a co-editor typed that the local editor has
 *     not shown yet is kept; without one, the fragment is made equal to the
 *     document (the server's AI edits and restores).
 * Normalisation output is never written: formula results are not stored and
 * the trailing empty paragraph normalizeLight adds is not inserted.
 */
import * as Y from 'yjs';
import {
    type AstNode, MAX_DEPTH, attrKeys, canonicalAttrs, elementAttrsFor, formatPatch, isBlockAtomType,
    isTextblockType, TEXTBLOCK, TEXTBLOCK_TYPES, astTypeOfElement, type Attrs,
} from './ySchema';
import {
    type YCache, type YParent, allowedKids, attachCache, isNormalisationParagraph, newBlockElement, readElement,
    sameInY, textOf, visibleChildren,
} from './yConvert';
import { type Tok, astTokens, insertTokens, sameContent, sameTok, yTokens } from './yText';
import { diffHunks } from '../diff/sequence';
import { rebase, type Splice } from '../diff/merge3';

interface Ctx {
    cache: YCache | null;
}

interface BaseItem {
    ast: AstNode;
    /** The live element it stands for, or null (never stored, or deleted by someone else). */
    y: Y.XmlElement | null;
    /** True when it was stored once and someone else has deleted it since. */
    gone?: boolean;
}

type Step =
    | { kind: 'keep'; d: AstNode; b: BaseItem }
    | { kind: 'update'; d: AstNode; b: BaseItem }
    | { kind: 'insert'; d: AstNode };

const TEXTBLOCK_KEYS: readonly string[] = ['type', ...new Set([...TEXTBLOCK_TYPES].flatMap((t) => attrKeys(t)))];
/** Largest changed stretch paired by similarity; bigger ones pair positionally. */
const MAX_PAIRING_CELLS = 400;

/**
 * Make the shared fragment hold `doc`, changing as little as possible. Runs
 * inside the caller's transaction when there is one (else in its own, with
 * `origin`). Pass the same cache as to fragmentToAst (see YCache).
 */
export function syncDocToFragment(fragment: Y.XmlFragment, doc: AstNode, cache?: YCache | null, origin?: unknown): void {
    const ydoc = fragment.doc;
    if (!ydoc) throw new Error('The fragment is not part of a Y.Doc.');
    const c = cache || null;
    if (c) attachCache(c, fragment);
    const target: AstNode = doc && doc.type === 'doc' ? doc : { type: 'doc', content: [] };
    const ctx: Ctx = { cache: c };
    ydoc.transact(() => syncChildren(ctx, { y: fragment, type: 'doc', depth: 0 }, target, c ? c.base : null), origin ?? null);
    if (c) c.base = target;
}

const isDeleted = (y: Y.XmlElement): boolean => !!y._item && y._item.deleted;

function baseItemsFor(ctx: Ctx, yParent: YParent, parentType: string, depth: number, base: AstNode | null): BaseItem[] {
    const cache = ctx.cache;
    if (base && cache) {
        const used = new Set<Y.XmlElement>();
        return allowedKids(base, depth).map((ast) => {
            const y = cache.ast.get(ast);
            if (!y) return { ast, y: null };
            // Deleted by someone else, or (defensively) a node object used twice.
            if (used.has(y) || y.parent !== yParent || isDeleted(y)) return { ast, y: null, gone: true };
            used.add(y);
            return { ast, y };
        });
    }
    return visibleChildren(yParent, parentType, depth).map(({ y, type }) => ({ ast: readElement(y, type, depth, cache), y }));
}

/** A shared container being synced: its element, AST type and depth (fragment = 0). */
interface Level {
    y: YParent;
    type: string;
    depth: number;
}

function syncChildren(ctx: Ctx, level: Level, desiredParent: AstNode, base: AstNode | null): void {
    const kidDepth = level.depth + 1;
    if (kidDepth > MAX_DEPTH) return;
    const desired = allowedKids(desiredParent, kidDepth);
    const items = baseItemsFor(ctx, level.y, level.type, kidDepth, base);
    const { steps, dels } = plan(items, desired, kidDepth);
    storeUnstoredSiblings(steps, dels);
    if (level.depth === 0) dropNormalisationTail(steps, desired);
    deleteItems(level.y, dels);
    applySteps(ctx, level.y, kidDepth, steps);
}

/**
 * A block that was never stored is a read repair (an empty list item's
 * paragraph) or, at the top, normalisation output. Left alone it stays
 * unstored; once the local side changes this list, it is stored like its
 * siblings so the result is what the user saw. The trailing normalisation
 * paragraph is the one exception (dropNormalisationTail).
 */
function storeUnstoredSiblings(steps: Step[], dels: BaseItem[]): void {
    if (!dels.length && steps.every((s) => s.kind === 'keep')) return;
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.kind === 'keep' && !s.b.y && !s.b.gone) steps[i] = { kind: 'insert', d: s.d };
    }
}

function deleteItems(yParent: YParent, dels: BaseItem[]): void {
    const doomed = new Set(dels.map((b) => b.y).filter((y): y is Y.XmlElement => y !== null));
    if (!doomed.size) return;
    const kids = yParent.toArray();
    for (let i = kids.length - 1; i >= 0; i--) if (doomed.has(kids[i] as Y.XmlElement)) yParent.delete(i, 1);
}

/** Walk the plan over the live children: update kept elements in place, insert new ones where they belong. */
function applySteps(ctx: Ctx, yParent: YParent, kidDepth: number, steps: Step[]): void {
    const arr = yParent.toArray() as unknown[];
    let cursor = 0;
    let pending: AstNode[] = [];
    const flush = () => {
        const els = pending.map((d) => newBlockElement(d, kidDepth, ctx.cache)).filter((e): e is Y.XmlElement => e !== null);
        pending = [];
        if (!els.length) return;
        yParent.insert(cursor, els);
        arr.splice(cursor, 0, ...els);
        cursor += els.length;
    };
    for (const s of steps) {
        if (s.kind === 'insert') { pending.push(s.d); continue; }
        const y = s.b.y;
        if (!y) {
            // Changed locally: the edit brings it (back). Unchanged: someone else's
            // delete stands, and a read repair stays unstored.
            if (s.kind === 'update') pending.push(s.d);
            continue;
        }
        flush();
        const idx = indexFrom(arr, y, cursor);
        if (idx < 0) continue;
        cursor = idx + 1;
        if (s.kind === 'update') syncNode(ctx, y, s.d, s.b.ast, kidDepth);
        else mapEquivalent(ctx, s.d, s.b.ast, y);
    }
    flush();
}

/** Match desired children to base items: keeps, in-place updates, inserts, deletes. */
function plan(items: BaseItem[], desired: AstNode[], depth: number): { steps: Step[]; dels: BaseItem[] } {
    const steps: Step[] = [];
    const dels: BaseItem[] = [];
    let bi = 0;
    let di = 0;
    // A node object present on both sides is that same block: it may only match
    // itself, never an equal-looking twin (two identical images, two empty lines).
    const baseNodes = new Set(items.map((b) => b.ast));
    const desiredNodes = new Set(desired);
    const same = (b: BaseItem, d: AstNode) =>
        b.ast === d || (!baseNodes.has(d) && !desiredNodes.has(b.ast) && sameInY(b.ast, d, depth));
    for (const h of diffHunks(items, desired, same)) {
        while (bi < h.a0) steps.push({ kind: 'keep', d: desired[di++], b: items[bi++] });
        for (const [x, y] of pairGap(items.slice(h.a0, h.a1).map((b) => b.ast), desired.slice(h.b0, h.b1))) {
            while (bi < h.a0 + x) dels.push(items[bi++]);
            while (di < h.b0 + y) steps.push({ kind: 'insert', d: desired[di++] });
            steps.push({ kind: 'update', d: desired[di++], b: items[bi++] });
        }
        while (bi < h.a1) dels.push(items[bi++]);
        while (di < h.b1) steps.push({ kind: 'insert', d: desired[di++] });
    }
    while (bi < items.length) steps.push({ kind: 'keep', d: desired[di++], b: items[bi++] });
    return { steps, dels };
}

/** The empty paragraph normalizeLight keeps at the end is not stored unless it already is. */
function dropNormalisationTail(steps: Step[], desired: AstNode[]): void {
    const last = steps[steps.length - 1];
    if (!last) return;
    const n = desired.length;
    if (!isNormalisationParagraph(desired[n - 1], desired[n - 2], n === 1)) return;
    if (last.kind === 'insert' || (last.kind === 'update' && !last.b.y)) steps.pop();
}

function indexFrom(arr: unknown[], y: unknown, from: number): number {
    for (let i = from; i < arr.length; i++) if (arr[i] === y) return i;
    return arr.indexOf(y);
}

/**
 * Record that an unchanged desired subtree lives in `y`, the element its base
 * twin `b` was paired with, and so on down (children of b live in children of y).
 */
function mapEquivalent(ctx: Ctx, d: AstNode, b: AstNode, y: Y.XmlElement): void {
    const cache = ctx.cache;
    if (!cache) return;
    cache.ast.set(d, y);
    if (d === b || isTextblockType(d.type)) return;
    const dk = d.content || [];
    const bk = b.content || [];
    if (dk.length !== bk.length) return;
    for (let i = 0; i < dk.length; i++) {
        const yk = childElement(cache, dk[i], bk[i], y);
        if (yk) mapEquivalent(ctx, dk[i], bk[i], yk);
    }
}

/** The live child of `y` that base child `b` lives in, unless `d` already lives elsewhere. */
function childElement(cache: YCache, d: AstNode | undefined, b: AstNode | undefined, y: Y.XmlElement): Y.XmlElement | null {
    const yk = b ? cache.ast.get(b) : undefined;
    if (!d || !yk || yk.parent !== y) return null;
    // Never move a node that already lives in another live element.
    const had = cache.ast.get(d);
    return had && had !== yk && had.parent && !isDeleted(had) ? null : yk;
}

/* ── pairing blocks of the same kind inside a changed stretch ─────────── */

const sameKind = (a: AstNode, b: AstNode): boolean =>
    a.type === b.type || (isTextblockType(a.type) && isTextblockType(b.type));

function plainText(n: AstNode): string {
    return (n.content || []).map((c) => (c.type === 'text' ? c.text || '' : '￼')).join('');
}

/** How much of `a` survives in `b` (0..1): common prefix + suffix over the longer length. */
function similarity(a: AstNode, b: AstNode): number {
    if (isBlockAtomType(a.type)) return sameInY(a, b) ? 1 : 0.5;
    const sa = isTextblockType(a.type) ? plainText(a) : (a.content || []);
    const sb = isTextblockType(b.type) ? plainText(b) : (b.content || []);
    const max = Math.max(sa.length, sb.length);
    if (max === 0) return 1;
    const eq = (i: number, j: number) => (typeof sa === 'string' ? sa[i] === (sb as string)[j] : sameInY((sa as AstNode[])[i], (sb as AstNode[])[j]));
    let p = 0;
    while (p < sa.length && p < sb.length && eq(p, p)) p++;
    let s = 0;
    while (s < sa.length - p && s < sb.length - p && eq(sa.length - 1 - s, sb.length - 1 - s)) s++;
    return (p + s) / max;
}

/**
 * Pairs [i, j] (increasing in both) of same-kind blocks to update in place.
 * Small stretches maximise the summed similarity; big ones pair from both ends.
 */
function pairGap(bs: AstNode[], ds: AstNode[]): Array<[number, number]> {
    if (!bs.length || !ds.length) return [];
    if (bs.length * ds.length > MAX_PAIRING_CELLS) return pairFromEnds(bs, ds);
    const m = bs.length;
    const n = ds.length;
    const score: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            let best = Math.max(score[i - 1][j], score[i][j - 1]);
            // A tiny bonus: a same-kind pair beats delete + insert even when nothing matches.
            if (sameKind(bs[i - 1], ds[j - 1])) best = Math.max(best, score[i - 1][j - 1] + similarity(bs[i - 1], ds[j - 1]) + 0.01);
            score[i][j] = best;
        }
    }
    const pairs: Array<[number, number]> = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (score[i][j] === score[i - 1][j]) i--;
        else if (score[i][j] === score[i][j - 1]) j--;
        else { pairs.push([i - 1, j - 1]); i--; j--; }
    }
    return pairs.reverse();
}

function pairFromEnds(bs: AstNode[], ds: AstNode[]): Array<[number, number]> {
    const head: Array<[number, number]> = [];
    let l = 0;
    while (l < bs.length && l < ds.length && sameKind(bs[l], ds[l])) { head.push([l, l]); l++; }
    const tail: Array<[number, number]> = [];
    let bi = bs.length - 1;
    let di = ds.length - 1;
    while (bi >= l && di >= l && sameKind(bs[bi], ds[di])) tail.push([bi--, di--]);
    return head.concat(tail.reverse());
}

/* ── updating one element in place ────────────────────────────────────── */

function syncNode(ctx: Ctx, y: Y.XmlElement, d: AstNode, b: AstNode, depth: number): void {
    syncAttrs(y, d, b);
    if (isTextblockType(d.type)) syncText(y, d, b);
    else if (!isBlockAtomType(d.type)) syncChildren(ctx, { y, type: d.type, depth }, d, b);
    if (ctx.cache) ctx.cache.ast.set(d, y);
}

/**
 * Set the attributes the local side changed. Values are read in the terms of
 * the target type, so a value a retype had hidden (a paragraph's alignment
 * while it was a code block) does not quietly come back; the base only vouches
 * for keys its own type shows.
 */
function syncAttrs(el: Y.XmlElement, d: AstNode, b: AstNode): void {
    const raw = el.getAttributes();
    const isTextblock = el.nodeName === TEXTBLOCK;
    const target = isTextblock ? elementAttrsFor(d) : canonicalAttrs(d.type, d.attrs);
    const base = isTextblock ? elementAttrsFor(b) : canonicalAttrs(b.type, b.attrs);
    const current = canonicalAttrs(d.type, raw);
    if (isTextblock) current.type = astTypeOfElement(el.nodeName, raw.type);
    // A local retype decides every attribute; otherwise only the ones it changed.
    const retype = b.type !== d.type;
    for (const k of isTextblock ? TEXTBLOCK_KEYS : attrKeys(d.type)) {
        const t = target[k];
        if (t === current[k]) {
            // Equal in the new type's terms: a leftover the new type does not show goes.
            if (retype && t === undefined && raw[k] !== undefined) el.removeAttribute(k);
            continue;
        }
        if (!retype && t === base[k]) continue;
        if (t === undefined) el.removeAttribute(k);
        else el.setAttribute(k, t as string);
    }
}

function syncText(el: Y.XmlElement, d: AstNode, b: AstNode): void {
    const inCode = d.type === 'codeBlock';
    let ytext = textOf(el);
    if (!ytext) {
        ytext = new Y.XmlText();
        el.insert(0, [ytext]);
    }
    const des = astTokens(d.content, inCode);
    const { toks: cur, length } = yTokens(ytext, inCode);
    // Code shows embeds differently (hard breaks as newlines, other atoms not at
    // all), so across a code ↔ text retype the base says nothing about what
    // others changed: the local retype decides the text (two-way).
    const base = (b.type === 'codeBlock') === inCode ? astTokens(b.content, inCode) : null;
    const { retag, splices } = rebase(base, cur, des, { content: sameContent, full: sameTok });
    applyRetags(ytext, cur, des, retag);
    for (const s of splices) applySplice(ytext, cur, length, des, s);
}

/** Formatting changes on kept characters, and attribute changes on kept atoms. */
function applyRetags(ytext: Y.XmlText, cur: Tok[], des: Tok[], retag: Array<[number, number]>): void {
    let i = 0;
    while (i < retag.length) {
        const [ci, di] = retag[i];
        const c = cur[ci];
        const t = des[di];
        if (c.ch === null) {
            if (c.el && t.atom) syncAtomAttrs(c.el, t.atom);
            i += 1;
            continue;
        }
        let j = i + 1;
        while (j < retag.length && retag[j][0] === retag[j - 1][0] + 1 && cur[retag[j][0]].ch !== null
            && des[retag[j][1]].key === t.key && cur[retag[j][0]].raw === c.raw && cur[retag[j][0]].yi === (cur[retag[j - 1][0]].yi as number) + 1) j++;
        ytext.format(c.yi as number, j - i, formatPatch(t.fmt || {}, c.raw || {}));
        i = j;
    }
}

function syncAtomAttrs(el: Y.XmlElement, atom: AstNode): void {
    const target = canonicalAttrs(atom.type, atom.attrs);
    const current = canonicalAttrs(atom.type, el.getAttributes());
    for (const k of attrKeys(atom.type)) {
        if (target[k] === current[k]) continue;
        if (target[k] === undefined) el.removeAttribute(k);
        else el.setAttribute(k, target[k] as string);
    }
}

function applySplice(ytext: Y.XmlText, cur: Tok[], yLength: number, des: Tok[], s: Splice): void {
    const at = s.at < cur.length ? (cur[s.at].yi as number) : yLength;
    if (s.del > 0) {
        const end = (cur[s.at + s.del - 1].yi as number) + 1;
        ytext.delete(at, end - at);
    }
    if (s.to > s.from) insertTokens(ytext, at, des.slice(s.from, s.to));
}
