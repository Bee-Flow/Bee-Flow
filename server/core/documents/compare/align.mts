/**
 * Sequence alignment for the document compare: two lists (slides, sheet rows,
 * lines) lined up as matched, paired-but-changed, added and removed.
 *
 *   1. The common prefix and suffix are matched first (most real edits touch
 *      a small middle, and a 2,000-row sheet then costs nothing).
 *   2. The middle is aligned by a longest common subsequence on an exact KEY
 *      (a slide's normalised title, a row's content). A null key never matches.
 *   3. Inside every stretch between two matches, items that are still ALIKE
 *      (similarity >= minSimilarity) are paired in order, by the best total
 *      similarity; the rest are added (right only) or removed (left only).
 *
 * Bounded: a middle larger than DOCUMENT_COMPARE_MAX_LCS_CELLS is matched by
 * position instead of by LCS, and a stretch larger than
 * DOCUMENT_COMPARE_MAX_PAIRING_CELLS pairs by position (./limits.mts).
 * Pure: no I/O.
 */

import { compareLimits } from './limits.mts';

export type AlignStep<A, B> =
    | { op: 'match'; a: A; b: B; ai: number; bi: number }
    | { op: 'pair'; a: A; b: B; ai: number; bi: number; similarity: number }
    | { op: 'insert'; b: B; bi: number }
    | { op: 'delete'; a: A; ai: number };

export interface AlignOptions<A, B> {
    keyA: (a: A) => string | null;
    keyB: (b: B) => string | null;
    /** 0..1; 0 = never pair. */
    similarity: (a: A, b: B) => number;
    minSimilarity: number;
}

function lcsPairs(ka: Array<string | null>, kb: Array<string | null>): Array<[number, number]> {
    const m = ka.length;
    const n = kb.length;
    if (!m || !n) return [];
    if (m * n > compareLimits().maxLcsCells) return [];
    const width = n + 1;
    const table = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            const here = i * width + j;
            if (ka[i] !== null && ka[i] === kb[j]) table[here] = table[(i + 1) * width + j + 1] + 1;
            else table[here] = Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const out: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (ka[i] !== null && ka[i] === kb[j]) { out.push([i, j]); i++; j++; }
        else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
        else j++;
    }
    return out;
}

/** Monotone pairs inside one stretch, by the best total similarity. */
function pairStretch<A, B>(as: A[], bs: B[], opts: AlignOptions<A, B>): Array<[number, number, number]> {
    const m = as.length;
    const n = bs.length;
    if (!m || !n) return [];
    const sim = (i: number, j: number) => {
        const s = opts.similarity(as[i], bs[j]);
        return s >= opts.minSimilarity ? s : 0;
    };
    if (m * n > compareLimits().maxPairingCells) {
        const out: Array<[number, number, number]> = [];
        for (let k = 0; k < Math.min(m, n); k++) { const s = sim(k, k); if (s > 0) out.push([k, k, s]); }
        return out;
    }
    const sims: Float64Array[] = Array.from({ length: m }, (_, i) => Float64Array.from({ length: n }, (_v, j) => sim(i, j)));
    const score: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const s = sims[i - 1][j - 1];
            score[i][j] = Math.max(score[i - 1][j], score[i][j - 1], s > 0 ? score[i - 1][j - 1] + s : 0);
        }
    }
    const out: Array<[number, number, number]> = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (score[i][j] === score[i - 1][j]) i--;
        else if (score[i][j] === score[i][j - 1]) j--;
        else { out.push([i - 1, j - 1, sims[i - 1][j - 1]]); i--; j--; }
    }
    return out.reverse();
}

/** Line up `as` (left / before) with `bs` (right / after). */
export function alignSequences<A, B>(as: readonly A[], bs: readonly B[], opts: AlignOptions<A, B>): AlignStep<A, B>[] {
    const ka = as.map(opts.keyA);
    const kb = bs.map(opts.keyB);
    const steps: AlignStep<A, B>[] = [];
    let head = 0;
    while (head < as.length && head < bs.length && ka[head] !== null && ka[head] === kb[head]) {
        steps.push({ op: 'match', a: as[head], b: bs[head], ai: head, bi: head });
        head++;
    }
    let tail = 0;
    while (tail < as.length - head && tail < bs.length - head
        && ka[as.length - 1 - tail] !== null && ka[as.length - 1 - tail] === kb[bs.length - 1 - tail]) tail++;

    const midA = ka.slice(head, as.length - tail);
    const midB = kb.slice(head, bs.length - tail);
    const anchors = lcsPairs(midA, midB).map(([i, j]) => [i + head, j + head] as [number, number]);

    let i = head;
    let j = head;
    /** The stretch [i, ai) × [j, bi): paired where alike, the rest removed / added. */
    const flush = (ai: number, bi: number) => {
        const stretchA = as.slice(i, ai);
        const stretchB = bs.slice(j, bi);
        let x = 0;
        let y = 0;
        for (const [pi, pj, s] of pairStretch(stretchA, stretchB, opts)) {
            while (x < pi) { steps.push({ op: 'delete', a: stretchA[x], ai: i + x }); x++; }
            while (y < pj) { steps.push({ op: 'insert', b: stretchB[y], bi: j + y }); y++; }
            steps.push({ op: 'pair', a: stretchA[x], b: stretchB[y], ai: i + x, bi: j + y, similarity: s });
            x++; y++;
        }
        while (x < stretchA.length) { steps.push({ op: 'delete', a: stretchA[x], ai: i + x }); x++; }
        while (y < stretchB.length) { steps.push({ op: 'insert', b: stretchB[y], bi: j + y }); y++; }
    };
    for (const [ai, bi] of anchors) {
        flush(ai, bi);
        steps.push({ op: 'match', a: as[ai], b: bs[bi], ai, bi });
        i = ai + 1;
        j = bi + 1;
    }
    flush(as.length - tail, bs.length - tail);
    for (let k = tail; k > 0; k--) {
        const ai = as.length - k;
        const bi = bs.length - k;
        steps.push({ op: 'match', a: as[ai], b: bs[bi], ai, bi });
    }
    return steps;
}
