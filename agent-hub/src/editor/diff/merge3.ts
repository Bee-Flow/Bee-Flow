/**
 * merge3.ts — carry one side's edits onto a sequence that others have
 * changed in the meantime.
 *
 * `base` is what the local side last saw, `des` is what it wants now and
 * `cur` is what the shared document holds now (base plus edits the local side
 * has not seen yet). The local edits (base → des) are expressed in `cur`
 * coordinates so they can be applied without undoing anyone else's work:
 * tokens someone else inserted survive, tokens someone else deleted stay
 * deleted, and a change both sides made identically is applied once.
 *
 * With no base (or base equal to cur) this is a plain two-way diff.
 */
import { diffHunks, equalPairs, type Hunk, DEFAULT_MAX_COST } from './sequence';

/** Delete `del` tokens of cur at `at`, then insert `des[from, to)` there. */
export interface Splice {
    at: number;
    del: number;
    from: number;
    to: number;
}

export interface Rebased {
    /** Tokens kept in place whose formatting / attributes change: [curIndex, desIndex]. */
    retag: Array<[number, number]>;
    /** Replacements in cur coordinates, ordered from the end so each applies to the unshifted prefix. */
    splices: Splice[];
}

export interface TokenEq<T> {
    /** May the token stay in place (same character / same kind of atom)? */
    content: (a: T, b: T) => boolean;
    /** Is it also identical (formatting, attributes)? */
    full: (a: T, b: T) => boolean;
}

export function rebase<T>(base: readonly T[] | null, cur: readonly T[], des: readonly T[], eq: TokenEq<T>, maxCost = DEFAULT_MAX_COST): Rebased {
    if (!base || sameSeq(base, cur, eq.full)) return twoWay(cur, des, eq, maxCost);
    const local = diffHunks(base, des, eq.content, maxCost);
    const remote = diffHunks(base, cur, eq.content, maxCost);
    const toCur = baseToCur(base.length, remote);
    const retag: Array<[number, number]> = [];
    for (const [bi, di] of equalPairs(base.length, local)) {
        const ci = toCur[bi];
        if (ci >= 0 && !eq.full(base[bi], des[di]) && !eq.full(cur[ci], des[di])) retag.push([ci, di]);
    }
    const splices: Splice[] = [];
    for (const h of local) {
        if (remote.some((r) => sameChange(r, h, cur, des, eq.full))) continue;
        for (const run of survivingRuns(h, toCur)) splices.push({ at: run[0], del: run[1], from: 0, to: 0 });
        if (h.b1 > h.b0) splices.push({ at: insertPoint(h.a0, toCur), del: 0, from: h.b0, to: h.b1 });
    }
    return { retag, splices: order(splices) };
}

function twoWay<T>(cur: readonly T[], des: readonly T[], eq: TokenEq<T>, maxCost: number): Rebased {
    const hunks = diffHunks(cur, des, eq.content, maxCost);
    const retag: Array<[number, number]> = [];
    for (const [ci, di] of equalPairs(cur.length, hunks)) if (!eq.full(cur[ci], des[di])) retag.push([ci, di]);
    const splices = hunks.map((h) => ({ at: h.a0, del: h.a1 - h.a0, from: h.b0, to: h.b1 }));
    return { retag, splices: order(splices) };
}

function sameSeq<T>(a: readonly T[], b: readonly T[], full: (x: T, y: T) => boolean): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!full(a[i], b[i])) return false;
    return true;
}

/** For every base index: where that token sits in cur, or -1 when someone deleted or replaced it. */
function baseToCur(baseLength: number, remote: readonly Hunk[]): Int32Array {
    const map = new Int32Array(baseLength).fill(-1);
    for (const [bi, ci] of equalPairs(baseLength, remote)) map[bi] = ci;
    return map;
}

/** Did the other side make exactly this change (same base range, same result)? */
function sameChange<T>(r: Hunk, h: Hunk, cur: readonly T[], des: readonly T[], full: (x: T, y: T) => boolean): boolean {
    if (r.a0 !== h.a0 || r.a1 !== h.a1 || r.b1 - r.b0 !== h.b1 - h.b0) return false;
    for (let i = 0; i < h.b1 - h.b0; i++) if (!full(cur[r.b0 + i], des[h.b0 + i])) return false;
    return true;
}

/** The cur runs [start, length] of base tokens in a locally deleted range that still exist. */
function survivingRuns(h: Hunk, toCur: Int32Array): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    for (let bi = h.a0; bi < h.a1; bi++) {
        const ci = toCur[bi];
        if (ci < 0) continue;
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === ci) last[1] += 1;
        else runs.push([ci, 1]);
    }
    return runs;
}

/** Where a local insertion at base boundary `b` lands in cur: right after the nearest surviving token before it. */
function insertPoint(b: number, toCur: Int32Array): number {
    for (let bi = b - 1; bi >= 0; bi--) if (toCur[bi] >= 0) return toCur[bi] + 1;
    return 0;
}

/**
 * From the end backwards. At the same position a deletion goes first, and of
 * two insertions the later one, so both end up in their original order.
 */
function order(splices: Splice[]): Splice[] {
    return splices.sort((x, y) => (y.at - x.at) || (y.del - x.del) || (y.from - x.from));
}
