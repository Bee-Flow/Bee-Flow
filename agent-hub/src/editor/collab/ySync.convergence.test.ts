/**
 * Convergence property: two or three co-editors make random edits to their
 * own copy of a document (text, formatting, splits, merges, retypes, block
 * inserts/deletes/moves, lists, tables, atoms), sync them through
 * syncDocToFragment, and exchange updates in random order and at random
 * moments — sometimes editing while behind, as an editor mid-composition is.
 * When everything is delivered, every copy must read back identically.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { markdownToAst } from '../serialization/mdToAst.js';
import { astToMarkdown } from '../serialization/astToMd.js';
import { normalizeLight } from '../engine/normalize.js';
import { inlineToTokens, tokensToInline } from '../engine/inline.js';
import { astToFragment, createYCache, fragmentToAst, sameInY, type YCache } from './yConvert';
import { syncDocToFragment } from './ySync';
import { FRAGMENT_NAME, type AstNode } from './ySchema';

/* ── deterministic randomness ─────────────────────────────────────────── */

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let x = s;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}
type Rand = () => number;
const int = (r: Rand, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rand, xs: T[]): T => xs[int(r, xs.length)];

/* ── immutable AST helpers ────────────────────────────────────────────── */

type Tok = { ch?: string; marks?: AstNode['marks']; node?: AstNode };
const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

function textblockPaths(d: AstNode): number[][] {
    const out: number[][] = [];
    const walk = (n: AstNode, path: number[]) => {
        if (TEXTBLOCKS.has(n.type)) { out.push(path); return; }
        (n.content || []).forEach((c, i) => walk(c, [...path, i]));
    };
    walk(d, []);
    return out;
}

const getAt = (d: AstNode, path: number[]): AstNode => path.reduce<AstNode>((n, i) => (n.content || [])[i], d);

function updateAt(d: AstNode, path: number[], fn: (n: AstNode) => AstNode | AstNode[]): AstNode {
    if (!path.length) return fn(d) as AstNode;
    const [i, ...rest] = path;
    const kids = (d.content || []).slice();
    if (rest.length) kids[i] = updateAt(kids[i], rest, fn);
    else {
        const r = fn(kids[i]);
        kids.splice(i, 1, ...(Array.isArray(r) ? r : [r]));
    }
    return { ...d, content: kids };
}

const toks = (b: AstNode): Tok[] => inlineToTokens(b.content || []) as Tok[];
/** Like the engine, never cut between the two halves of a surrogate pair. */
function snap(ts: Tok[], i: number): number {
    const hi = ts[i - 1]?.ch;
    const lo = ts[i]?.ch;
    const isHi = !!hi && hi.charCodeAt(0) >= 0xd800 && hi.charCodeAt(0) <= 0xdbff;
    const isLo = !!lo && lo.charCodeAt(0) >= 0xdc00 && lo.charCodeAt(0) <= 0xdfff;
    return isHi && isLo ? i + 1 : i;
}
const fromToks = (b: AstNode, ts: Tok[]): AstNode => ({ ...b, content: tokensToInline(ts) as AstNode[] });

/* ── random edits ─────────────────────────────────────────────────────── */

const WORDS = ['alpha ', 'beta ', 'x', 'yz', ' ', 'Q', 'ümlaut ', '42', '👍'];
const BLOCKS: Array<() => AstNode> = [
    () => ({ type: 'paragraph', content: [{ type: 'text', text: 'new para' }] }),
    () => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'new head' }] }),
    () => ({ type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item 1' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item 2' }] }] }] }),
    () => ({ type: 'table', content: [0, 1].map((r) => ({ type: 'tableRow', content: [0, 1].map((c) => ({
        type: 'tableCell', attrs: r === 0 ? { header: true } : undefined,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `c${r}${c}` }] }] })) })) }),
    () => ({ type: 'image', attrs: { src: 'https://example.com/i.png', width: 200 } }),
    () => ({ type: 'horizontalRule' }),
    () => ({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] }),
    () => ({ type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'task' }] }] }] }),
];

type Edit = (d: AstNode, r: Rand) => AstNode;

const EDITS: Edit[] = [
    function insertText(d, r) {
        const path = pick(r, textblockPaths(d));
        const b = getAt(d, path);
        const ts = toks(b);
        const at = snap(ts, int(r, ts.length + 1));
        const marks = b.type !== 'codeBlock' && r() < 0.3 ? [{ type: pick(r, ['bold', 'italic']) }] : undefined;
        const add = [...pick(r, WORDS)].flatMap((ch) => [...ch].map((c) => ({ ch: c, marks: marks || [] })));
        return updateAt(d, path, (n) => fromToks(n, [...ts.slice(0, at), ...add, ...ts.slice(at)]));
    },
    function deleteText(d, r) {
        const path = pick(r, textblockPaths(d));
        const ts = toks(getAt(d, path));
        if (!ts.length) return d;
        const from = snap(ts, int(r, ts.length));
        const to = snap(ts, Math.min(ts.length, from + 1 + int(r, 6)));
        return updateAt(d, path, (n) => fromToks(n, [...ts.slice(0, from), ...ts.slice(to)]));
    },
    function toggleMark(d, r) {
        const path = pick(r, textblockPaths(d));
        const b = getAt(d, path);
        if (b.type === 'codeBlock') return d;
        const ts = toks(b);
        if (!ts.length) return d;
        const from = snap(ts, int(r, ts.length));
        const to = snap(ts, Math.min(ts.length, from + 1 + int(r, 8)));
        const type = pick(r, ['bold', 'italic', 'strike']);
        const next = ts.map((tk, i) => {
            if (i < from || i >= to || tk.node) return tk;
            const has = (tk.marks || []).some((m) => m.type === type);
            return { ch: tk.ch, marks: has ? (tk.marks || []).filter((m) => m.type !== type) : [...(tk.marks || []), { type }] };
        });
        return updateAt(d, path, (n) => fromToks(n, next));
    },
    function split(d, r) {
        const path = pick(r, textblockPaths(d));
        const ts = toks(getAt(d, path));
        const at = snap(ts, int(r, ts.length + 1));
        return updateAt(d, path, (n) => [fromToks(n, ts.slice(0, at)), fromToks({ ...n }, ts.slice(at))]);
    },
    function merge(d, r) {
        const path = pick(r, textblockPaths(d));
        const parentPath = path.slice(0, -1);
        const i = path[path.length - 1];
        const parent = getAt(d, parentPath);
        const next = (parent.content || [])[i + 1];
        if (!next || !TEXTBLOCKS.has(next.type)) return d;
        const merged = fromToks(getAt(d, path), [...toks(getAt(d, path)), ...toks(next)]);
        return updateAt(d, parentPath, (pn) => ({ ...pn, content: (pn.content || []).filter((_, j) => j !== i + 1).map((c, j) => (j === i ? merged : c)) }));
    },
    function retype(d, r) {
        const path = pick(r, textblockPaths(d));
        return updateAt(d, path, (n) => {
            const type = pick(r, ['paragraph', 'heading', 'codeBlock']);
            const plain = type === 'codeBlock'
                ? [{ type: 'text', text: toks(n).map((tk) => tk.ch ?? '').join('') }].filter((x) => x.text)
                : n.content;
            return type === 'heading' ? { type, attrs: { level: 1 + int(r, 3) }, content: plain } : { type, content: plain };
        });
    },
    function insertBlock(d, r) {
        const at = int(r, (d.content || []).length + 1);
        const content = (d.content || []).slice();
        content.splice(at, 0, pick(r, BLOCKS)());
        return { ...d, content };
    },
    function deleteBlock(d, r) {
        if ((d.content || []).length < 2) return d;
        const at = int(r, (d.content || []).length);
        return { ...d, content: (d.content || []).filter((_, i) => i !== at) };
    },
    function moveBlock(d, r) {
        const content = (d.content || []).slice();
        if (content.length < 2) return d;
        const [b] = content.splice(int(r, content.length), 1);
        content.splice(int(r, content.length + 1), 0, b);
        return { ...d, content };
    },
    function insertAtom(d, r) {
        const paths = textblockPaths(d).filter((p) => getAt(d, p).type !== 'codeBlock');
        if (!paths.length) return d;
        const path = pick(r, paths);
        const ts = toks(getAt(d, path));
        const at = snap(ts, int(r, ts.length + 1));
        const node = pick(r, [{ type: 'hardBreak' }, { type: 'mathInline', attrs: { latex: 'x^2' } }, { type: 'formula', attrs: { src: '=1+2' } }]);
        return updateAt(d, path, (n) => fromToks(n, [...ts.slice(0, at), { node }, ...ts.slice(at)]));
    },
    function setAttrs(d, r) {
        const i = int(r, (d.content || []).length);
        return updateAt(d, [i], (n) => {
            if (n.type === 'image') return { ...n, attrs: { ...n.attrs, width: 100 + int(r, 300) } };
            if (n.type === 'heading') return { ...n, attrs: { ...n.attrs, level: 1 + int(r, 3) } };
            if (n.type === 'taskList') return { ...n, content: (n.content || []).map((it) => ({ ...it, attrs: { checked: r() < 0.5 } })) };
            if (n.type === 'paragraph') return { ...n, attrs: r() < 0.5 ? { align: 'center' } : undefined };
            return n;
        });
    },
    function editTableRow(d, r) {
        const i = (d.content || []).findIndex((b) => b.type === 'table');
        if (i < 0) return d;
        return updateAt(d, [i], (tbl) => {
            const rows = (tbl.content || []).slice();
            if (r() < 0.5 && rows.length > 1) rows.splice(1 + int(r, rows.length - 1), 1);
            else rows.splice(int(r, rows.length + 1), 0, { type: 'tableRow', content: [0, 1].map(() => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'r' }] }] })) });
            return { ...tbl, content: rows };
        });
    },
];

/* ── simulation ───────────────────────────────────────────────────────── */

const LOCAL = Symbol('local');
const REMOTE = Symbol('remote');

interface Client { ydoc: Y.Doc; fragment: Y.XmlFragment; cache: YCache; view: AstNode; inbox: Uint8Array[]; behind: boolean }

function makeClient(id: number, seedUpdate: Uint8Array, outboxes: Uint8Array[][], index: number): Client {
    const ydoc = new Y.Doc();
    ydoc.clientID = id;
    Y.applyUpdate(ydoc, seedUpdate, REMOTE);
    // Forward everything that did not come from the network: besides our own
    // edits, Yjs cleans up redundant formatting in a follow-up transaction of
    // its own (origin null), and peers need that too.
    ydoc.on('update', (u: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE) outboxes.forEach((box, j) => { if (j !== index) box.push(u); });
    });
    const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
    const cache = createYCache();
    return { ydoc, fragment, cache, view: normalizeLight(fragmentToAst(fragment, cache)) as AstNode, inbox: outboxes[index], behind: false };
}

const reread = (c: Client) => { c.view = normalizeLight(fragmentToAst(c.fragment, c.cache)) as AstNode; c.behind = false; };

function runScenario(seedNo: number, clients: number, steps: number): void {
    const r = rng(seedNo);
    const origin = new Y.Doc();
    astToFragment(normalizeLight(markdownToAst('# Plan\n\nFirst paragraph with **bold** text.\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | =A2+1 |\n\nLast words.')) as AstNode, origin.getXmlFragment(FRAGMENT_NAME));
    const seedUpdate = Y.encodeStateAsUpdate(origin);
    const boxes: Uint8Array[][] = Array.from({ length: clients }, () => []);
    const cs = Array.from({ length: clients }, (_, i) => makeClient(100 + i, seedUpdate, boxes, i));
    for (let s = 0; s < steps; s++) {
        const c = pick(r, cs);
        const roll = r();
        if (roll < 0.55) {
            const next = normalizeLight(pick(r, EDITS)(c.view, r)) as AstNode;
            c.ydoc.transact(() => syncDocToFragment(c.fragment, next, c.cache), LOCAL);
            // An editor that is up to date gets exactly what it asked for.
            if (!c.behind) expect(sameInY(normalizeLight(fragmentToAst(c.fragment)) as AstNode, next)).toBe(true);
            c.view = next;
        } else if (roll < 0.9 && c.inbox.length) {
            // Deliver a random subset of pending updates, in random order.
            const n = 1 + int(r, c.inbox.length);
            for (let k = 0; k < n; k++) Y.applyUpdate(c.ydoc, c.inbox.splice(int(r, c.inbox.length), 1)[0], REMOTE);
            if (r() < 0.25) c.behind = true; // the editor catches up later
            else reread(c);
        } else if (c.behind) reread(c);
    }
    for (const c of cs) { while (c.inbox.length) Y.applyUpdate(c.ydoc, c.inbox.shift() as Uint8Array, REMOTE); reread(c); }
    const reads = cs.map((c) => fragmentToAst(c.fragment));
    for (let i = 1; i < reads.length; i++) expect(reads[i]).toEqual(reads[0]);
    // Cached and uncached reads agree, and the result is a usable document.
    cs.forEach((c) => expect(fragmentToAst(c.fragment, c.cache)).toEqual(reads[0]));
    expect(() => astToMarkdown(normalizeLight(reads[0]))).not.toThrow();
    cs.forEach((c) => c.cache.destroy());
}

describe('co-editors converge', () => {
    for (let seedNo = 1; seedNo <= 24; seedNo++) {
        const clients = seedNo % 3 === 0 ? 3 : 2;
        it(`seed ${seedNo}: ${clients} editors, random edits and delivery`, () => runScenario(seedNo, clients, 80));
    }

    it('also when every step is an edit made while behind', () => {
        const r = rng(4242);
        const origin = new Y.Doc();
        astToFragment(normalizeLight(markdownToAst('one\n\ntwo\n\nthree')) as AstNode, origin.getXmlFragment(FRAGMENT_NAME));
        const seedUpdate = Y.encodeStateAsUpdate(origin);
        const boxes: Uint8Array[][] = [[], []];
        const [a, b] = [makeClient(7, seedUpdate, boxes, 0), makeClient(8, seedUpdate, boxes, 1)];
        for (let s = 0; s < 60; s++) {
            for (const c of [a, b]) {
                const next = normalizeLight(pick(r, EDITS.slice(0, 5))(c.view, r)) as AstNode;
                c.ydoc.transact(() => syncDocToFragment(c.fragment, next, c.cache), LOCAL);
                c.view = next;
            }
            // Deliver without re-reading: both editors keep working on stale views.
            for (const c of [a, b]) while (c.inbox.length) Y.applyUpdate(c.ydoc, c.inbox.shift() as Uint8Array, REMOTE);
            if (s % 10 === 9) { reread(a); reread(b); }
        }
        reread(a);
        reread(b);
        expect(fragmentToAst(a.fragment)).toEqual(fragmentToAst(b.fragment));
    });
});
