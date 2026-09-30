/**
 * sequence.ts — a bounded shortest-edit-script diff (Myers, O((N+M)·D)) over
 * any two sequences, reported as replace hunks.
 *
 * Used by the co-editing sync (characters of a textblock) and by the version
 * compare (blocks of a document, words of a block). The work is bounded: past
 * `maxCost` edits the middle is reported as one replace hunk, which is always
 * correct, just less minimal.
 */

/** `a[a0, a1)` is replaced by `b[b0, b1)`; everything between hunks is equal. */
export interface Hunk {
    a0: number;
    a1: number;
    b0: number;
    b1: number;
}

export const DEFAULT_MAX_COST = 1000;

/**
 * The hunks that turn `a` into `b`, in order. `eq(a[i], b[j])` decides which
 * elements may stay. Common prefixes and suffixes are trimmed first, so a
 * single local edit costs O(N) regardless of the bound.
 */
export function diffHunks<A, B>(
    a: readonly A[],
    b: readonly B[],
    eq: (x: A, y: B) => boolean,
    maxCost: number = DEFAULT_MAX_COST,
): Hunk[] {
    let s = 0;
    while (s < a.length && s < b.length && eq(a[s], b[s])) s++;
    let ea = a.length;
    let eb = b.length;
    while (ea > s && eb > s && eq(a[ea - 1], b[eb - 1])) { ea--; eb--; }
    if (s === ea && s === eb) return [];
    if (s === ea || s === eb) return [{ a0: s, a1: ea, b0: s, b1: eb }];
    const range: Hunk = { a0: s, a1: ea, b0: s, b1: eb };
    return myers(a, b, range, eq, maxCost) ?? [range];
}

/** Forward Myers over a[a0, a1) × b[b0, b1) with a per-round trace for the backtrack; null past the bound. */
function myers<A, B>(a: readonly A[], b: readonly B[], range: Hunk, eq: (x: A, y: B) => boolean, maxCost: number): Hunk[] | null {
    const { a0: sa, b0: sb } = range;
    const n = range.a1 - sa;
    const m = range.b1 - sb;
    const max = Math.min(n + m, Math.max(1, maxCost));
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= max; d++) {
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && eq(a[sa + x], b[sb + y])) { x++; y++; }
            v[off + k] = x;
            if (x >= n && y >= m) {
                trace.push(v.slice(off - d, off + d + 1));
                return backtrack(trace, n, m, sa, sb);
            }
        }
        trace.push(v.slice(off - d, off + d + 1));
    }
    return null;
}

/** Walk the trace back from (n, m) and group single edits into hunks. */
function backtrack(trace: Int32Array[], n: number, m: number, sa: number, sb: number): Hunk[] {
    // Each edit is recorded by the point it starts from: 'del' of a[x] or 'ins' of b[y].
    const edits: Array<{ x: number; y: number; del: boolean }> = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d > 0; d--) {
        const prev = trace[d - 1];
        const at = (k: number) => prev[k + (d - 1)];
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const pk = down ? k + 1 : k - 1;
        const px = at(pk);
        const py = px - pk;
        edits.push({ x: px, y: py, del: !down });
        x = px;
        y = py;
    }
    edits.reverse();
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const e of edits) {
        if (!cur || cur.a1 !== sa + e.x || cur.b1 !== sb + e.y) {
            cur = { a0: sa + e.x, a1: sa + e.x, b0: sb + e.y, b1: sb + e.y };
            hunks.push(cur);
        }
        if (e.del) cur.a1 += 1;
        else cur.b1 += 1;
    }
    return hunks;
}

/** The equal pairs between hunks, as [aIndex, bIndex], in order. */
export function equalPairs(aLength: number, hunks: readonly Hunk[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    for (const h of hunks) {
        while (i < h.a0) out.push([i++, j++]);
        i = h.a1;
        j = h.b1;
    }
    while (i < aLength) out.push([i++, j++]);
    return out;
}
