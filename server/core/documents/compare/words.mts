/**
 * The word level of the document compare: a text as word, space and
 * punctuation tokens, a word diff between two lines, how alike two texts
 * are, and a line diff (lines aligned, words diffed inside a changed line).
 *
 * The same token rule as the editor's version compare (agent-hub
 * src/editor/diff/words.ts), so a slide line and a paragraph read alike.
 * Pure and bounded: a line past MAX_WORD_TOKENS is reported as replaced.
 */

import { alignSequences } from './align.mts';

export type WordOp = 'equal' | 'insert' | 'delete';
export interface DiffWord { op: WordOp; text: string }

export type LineOp = 'equal' | 'insert' | 'delete' | 'modify';
export interface DiffLine {
    op: LineOp;
    before?: string;
    after?: string;
    /** A modified line, word by word. */
    words?: DiffWord[];
}

/** Word (letters, digits, marks, with inner ' ’ -), whitespace run, or one other character. */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*|\s+|[\s\S]/gu;
const WORDISH = /^[\p{L}\p{N}]/u;
/** Longest line diffed word by word (tokens per side). */
export const MAX_WORD_TOKENS = 2000;
/** Least word overlap for two lines to count as one line, changed. */
export const LINE_MIN_SIMILARITY = 0.4;

export function tokens(text: string): string[] {
    return String(text ?? '').match(TOKEN) || [];
}

/** The words of a text, lower-cased: what similarity and the counts look at. */
export function wordsOf(text: string): string[] {
    return tokens(text).filter((t) => WORDISH.test(t)).map((t) => t.toLowerCase());
}

/** Dice coefficient of the two word multisets (0 = nothing shared, 1 = the same words). */
export function bagSimilarity(a: string, b: string): number {
    const wa = wordsOf(a);
    const wb = wordsOf(b);
    if (!wa.length && !wb.length) return a.trim() === b.trim() ? 1 : 0;
    if (!wa.length || !wb.length) return 0;
    const counts = new Map<string, number>();
    for (const w of wa) counts.set(w, (counts.get(w) || 0) + 1);
    let shared = 0;
    for (const w of wb) {
        const n = counts.get(w) || 0;
        if (n > 0) { shared++; counts.set(w, n - 1); }
    }
    return (2 * shared) / (wa.length + wb.length);
}

function pushRun(out: DiffWord[], op: WordOp, text: string): void {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
}

/** `before` → `after`, word by word (runs of the same op merged). */
export function diffWords(before: string, after: string): DiffWord[] {
    const a = tokens(before);
    const b = tokens(after);
    const out: DiffWord[] = [];
    if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) {
        pushRun(out, 'delete', before);
        pushRun(out, 'insert', after);
        return out;
    }
    for (const s of alignSequences(a, b, { keyA: (t) => t, keyB: (t) => t, similarity: () => 0, minSimilarity: 1 })) {
        if (s.op === 'match') pushRun(out, 'equal', s.a);
        else if (s.op === 'delete') pushRun(out, 'delete', s.a);
        else if (s.op === 'insert') pushRun(out, 'insert', s.b);
    }
    // A delete run directly followed by an insert run reads best as "old → new":
    // the aligner emits them in that order already, so nothing to reorder.
    return out;
}

/** Two lists of lines: equal, added, removed, or one line changed (with its word diff). */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
    const out: DiffLine[] = [];
    const steps = alignSequences(before, after, {
        keyA: (l) => l,
        keyB: (l) => l,
        similarity: bagSimilarity,
        minSimilarity: LINE_MIN_SIMILARITY,
    });
    for (const s of steps) {
        if (s.op === 'match') out.push({ op: 'equal', before: s.a, after: s.b });
        else if (s.op === 'pair') out.push({ op: 'modify', before: s.a, after: s.b, words: diffWords(s.a, s.b) });
        else if (s.op === 'delete') out.push({ op: 'delete', before: s.a });
        else out.push({ op: 'insert', after: s.b });
    }
    return out;
}

/** How many words a line diff adds and removes. */
export function lineStats(lines: readonly DiffLine[]): { wordsAdded: number; wordsRemoved: number } {
    let wordsAdded = 0;
    let wordsRemoved = 0;
    for (const l of lines) {
        if (l.op === 'insert') wordsAdded += wordsOf(l.after || '').length;
        else if (l.op === 'delete') wordsRemoved += wordsOf(l.before || '').length;
        else if (l.op === 'modify') {
            for (const w of l.words || []) {
                if (w.op === 'insert') wordsAdded += wordsOf(w.text).length;
                else if (w.op === 'delete') wordsRemoved += wordsOf(w.text).length;
            }
        }
    }
    return { wordsAdded, wordsRemoved };
}
