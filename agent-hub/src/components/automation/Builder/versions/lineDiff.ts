// A line diff of two texts (a code step, a prompt, a message), for the version
// compare. Pure. The edit script is the bounded Myers diff the document
// compare already uses (editor/diff/sequence.ts): past its cost bound the middle
// of the text is reported as one replaced block, which is always correct, just
// less minimal.

import { DEFAULT_MAX_COST, diffHunks } from '../../../../editor/diff/sequence';

export type LineKind = 'same' | 'add' | 'del' | 'gap';

export interface LineRow {
    kind: LineKind;
    /** 1-based line number in the old text; null for an added line and a gap. */
    oldNo: number | null;
    /** 1-based line number in the new text; null for a deleted line and a gap. */
    newNo: number | null;
    text: string;
    /** A gap: how many unchanged lines it stands for. */
    hidden?: number;
    /** A gap: those lines, so the screen can unfold them. */
    hiddenRows?: LineRow[];
}

export interface LineDiffOptions {
    /** Unchanged lines kept around each change. Infinity keeps all of them. */
    context?: number;
    /** The cost bound of the edit script. */
    maxCost?: number;
}

/** Lines of a text, whatever its line ends; a final line end does not start another line. */
export function splitLines(text: string | null | undefined): string[] {
    if (!text) return [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

/** Every line of both texts, marked same, added or deleted. */
function allRows(a: string[], b: string[], maxCost: number): LineRow[] {
    const rows: LineRow[] = [];
    let i = 0;
    let j = 0;
    const same = (until: number) => {
        while (i < until) { rows.push({ kind: 'same', oldNo: i + 1, newNo: j + 1, text: a[i] }); i++; j++; }
    };
    for (const h of diffHunks(a, b, (x, y) => x === y, maxCost)) {
        same(h.a0);
        for (; i < h.a1; i++) rows.push({ kind: 'del', oldNo: i + 1, newNo: null, text: a[i] });
        for (; j < h.b1; j++) rows.push({ kind: 'add', oldNo: null, newNo: j + 1, text: b[j] });
    }
    same(a.length);
    return rows;
}

/** A run of unchanged lines is folded only when folding hides at least this many. */
const MIN_FOLD = 2;

/** Fold the unchanged lines further than `context` from any change into gap rows. */
function fold(rows: LineRow[], context: number): LineRow[] {
    if (!Number.isFinite(context)) return rows;
    const near = new Array<boolean>(rows.length).fill(false);
    rows.forEach((r, idx) => {
        if (r.kind === 'same') return;
        for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) near[k] = true;
    });
    const out: LineRow[] = [];
    let idx = 0;
    while (idx < rows.length) {
        if (near[idx]) { out.push(rows[idx++]); continue; }
        const start = idx;
        while (idx < rows.length && !near[idx]) idx++;
        const run = rows.slice(start, idx);
        if (run.length < MIN_FOLD) out.push(...run);
        else out.push({ kind: 'gap', oldNo: null, newNo: null, text: '', hidden: run.length, hiddenRows: run });
    }
    return out;
}

/**
 * The rows of a line diff, in order. Unchanged lines more than `context` away
 * from a change are folded into `gap` rows (`hidden` says how many).
 */
export function lineDiff(before: string | null | undefined, after: string | null | undefined, options: LineDiffOptions = {}): LineRow[] {
    const { context = 3, maxCost = DEFAULT_MAX_COST } = options;
    return fold(allRows(splitLines(before), splitLines(after), maxCost), Math.max(0, context));
}

/** How many lines were added and removed. */
export function lineDiffStats(rows: LineRow[]): { added: number; removed: number } {
    return {
        added: rows.filter((r) => r.kind === 'add').length,
        removed: rows.filter((r) => r.kind === 'del').length,
    };
}
