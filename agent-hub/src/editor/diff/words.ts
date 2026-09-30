/**
 * words.ts — the word level of the version compare: a block's text as word,
 * space and punctuation tokens, a bounded word diff between two blocks, and
 * a cheap similarity score used to decide whether two blocks are "the same
 * block, changed" or unrelated.
 *
 * Inline atoms are single tokens compared by their stored attributes; their
 * display text is what a reader recognises them by (a formula's source, the
 * LaTeX of inline math).
 */
import { attrsKey, canonicalAttrs, type AstNode } from '../collab/ySchema';
import { diffHunks } from './sequence';

export type WordOp = 'equal' | 'insert' | 'delete';

/** A run of the compared text with what happened to it. `text` keeps its spaces. */
export interface DiffWord {
    op: WordOp;
    text: string;
}

/** One token: `k` compares, `t` displays, `w` counts as a word in the statistics. */
export interface WordTok {
    k: string;
    t: string;
    w: boolean;
}

/** Word (letters, digits, marks, with inner ' ’ -), whitespace run, or one other character. */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|\s+|[\s\S]/gu;
const WORDISH = /^[\p{L}\p{N}]/u;
/** Longest block text diffed word by word; longer ones are shown as replaced. */
const MAX_WORD_TOKENS = 4000;
/** Edit budget of one block's word diff (see diffHunks). */
const WORD_COST = 400;

function pushText(out: WordTok[], text: string): void {
    for (const m of text.matchAll(TOKEN)) {
        const t = m[0];
        out.push({ k: t, t, w: WORDISH.test(t) });
    }
}

function atomText(n: AstNode): string {
    const a = n.attrs || {};
    if (n.type === 'formula') return typeof a.src === 'string' ? a.src : '';
    if (n.type === 'mathInline') return typeof a.latex === 'string' ? a.latex : '';
    if (n.type === 'image') return typeof a.alt === 'string' ? a.alt : '';
    return '';
}

/** Tokens of a textblock's inline content (code blocks: plain text). */
export function blockTokens(node: AstNode): WordTok[] {
    const out: WordTok[] = [];
    const inCode = node.type === 'codeBlock';
    let text = '';
    for (const n of node.content || []) {
        if (!n) continue;
        if (n.type === 'text') { text += typeof n.text === 'string' ? n.text : ''; continue; }
        if (n.type === 'hardBreak') { text += '\n'; continue; }
        if (inCode) continue;
        pushText(out, text);
        text = '';
        out.push({ k: `\u0000${n.type}\u0001${attrsKey(canonicalAttrs(n.type, n.attrs))}`, t: atomText(n), w: true });
    }
    pushText(out, text);
    return out;
}

/** Number of word tokens (the unit of wordsAdded / wordsRemoved). */
export const countWords = (toks: readonly WordTok[]): number => toks.reduce((n, t) => n + (t.w ? 1 : 0), 0);

export interface WordDiff {
    words: DiffWord[];
    added: number;
    removed: number;
    /** True when the text is the same (only formatting, type or attributes differ). */
    sameText: boolean;
}

const isSpace = (t: WordTok): boolean => /^\s+$/.test(t.t);

/**
 * Word-level diff of two blocks. A single space between two changes is
 * folded into them, so "the quick brown" → "the slow red" reads as one
 * replacement rather than two.
 */
export function diffWords(a: readonly WordTok[], b: readonly WordTok[]): WordDiff {
    if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) return replaced(a, b);
    const hunks = diffHunks(a, b, (x, y) => x.k === y.k, WORD_COST);
    if (!hunks.length) return { words: join(a.map((t) => ({ op: 'equal' as const, tok: t }))), added: 0, removed: 0, sameText: true };
    const ops: Array<{ op: WordOp; tok: WordTok }> = [];
    let i = 0;
    for (const h of hunks) {
        while (i < h.a0) ops.push({ op: 'equal', tok: a[i++] });
        for (let x = h.a0; x < h.a1; x++) ops.push({ op: 'delete', tok: a[x] });
        for (let y = h.b0; y < h.b1; y++) ops.push({ op: 'insert', tok: b[y] });
        i = h.a1;
    }
    while (i < a.length) ops.push({ op: 'equal', tok: a[i++] });
    const folded = foldSpaces(ops);
    let added = 0;
    let removed = 0;
    for (const o of folded) {
        if (!o.tok.w) continue;
        if (o.op === 'insert') added++;
        else if (o.op === 'delete') removed++;
    }
    return { words: join(folded), added, removed, sameText: false };
}

function replaced(a: readonly WordTok[], b: readonly WordTok[]): WordDiff {
    const words: DiffWord[] = [];
    const at = a.map((t) => t.t).join('');
    const bt = b.map((t) => t.t).join('');
    if (at) words.push({ op: 'delete', text: at });
    if (bt) words.push({ op: 'insert', text: bt });
    return { words, added: countWords(b), removed: countWords(a), sameText: at === bt };
}

/** Turn a whitespace-only equal token between two changes into a delete + insert. */
function foldSpaces(ops: Array<{ op: WordOp; tok: WordTok }>): Array<{ op: WordOp; tok: WordTok }> {
    const out: Array<{ op: WordOp; tok: WordTok }> = [];
    for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        const prev = ops[i - 1];
        const next = ops[i + 1];
        if (o.op === 'equal' && isSpace(o.tok) && prev && next && prev.op !== 'equal' && next.op !== 'equal') {
            out.push({ op: 'delete', tok: o.tok }, { op: 'insert', tok: o.tok });
        } else out.push(o);
    }
    return out;
}

/** Merge tokens into runs; inside a changed stretch all removals come before all additions. */
function join(ops: Array<{ op: WordOp; tok: WordTok }>): DiffWord[] {
    const out: DiffWord[] = [];
    let del = '';
    let ins = '';
    const flush = () => {
        if (del) out.push({ op: 'delete', text: del });
        if (ins) out.push({ op: 'insert', text: ins });
        del = '';
        ins = '';
    };
    for (const o of ops) {
        if (o.op === 'delete') { del += o.tok.t; continue; }
        if (o.op === 'insert') { ins += o.tok.t; continue; }
        flush();
        const last = out[out.length - 1];
        if (last && last.op === 'equal') last.text += o.tok.t;
        else out.push({ op: 'equal', text: o.tok.t });
    }
    flush();
    return out.filter((w) => w.text !== '');
}

/** Counts of the non-space tokens of a block, for similarity. */
export function tokenBag(toks: readonly WordTok[]): Map<string, number> {
    const bag = new Map<string, number>();
    for (const t of toks) {
        if (isSpace(t)) continue;
        const k = t.w ? t.k.toLowerCase() : t.k;
        bag.set(k, (bag.get(k) || 0) + 1);
    }
    return bag;
}

/** Dice similarity of two bags (0..1); two empty bags are identical. */
export function bagSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let na = 0;
    let nb = 0;
    a.forEach((n) => { na += n; });
    b.forEach((n) => { nb += n; });
    if (na + nb === 0) return 1;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let common = 0;
    small.forEach((n, k) => { common += Math.min(n, big.get(k) || 0); });
    return (2 * common) / (na + nb);
}
