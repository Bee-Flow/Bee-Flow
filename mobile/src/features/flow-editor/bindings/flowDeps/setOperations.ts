/**
 * "Edit data" (set) whole-table operations — the two folds the bindings layer
 * needs, from agent-hub `Builder/flow/setOperations.js`. Semantics mirror the
 * runtime (server engine.js applySetOperations): ops run in listed order, AFTER
 * the per-row fields overlay; sort changes order only, so it is a no-op for
 * both folds. Pinned by flowDeps.lockstep.test.ts.
 */

import { arr, isObj } from '../json';
import type { Obj } from '../types';

const col = (k: unknown): k is string => typeof k === 'string' && k.trim().length > 0;

function keysOf(o: Obj): string[] {
    return arr(o.keys).filter(col);
}

function renameCols(cols: string[], o: Obj): string[] {
    return [...new Set(cols.map((c) => (c === o.from ? (o.to as string) : c)))];
}

function foldColumns(cols: string[], o: Obj): string[] {
    if ((o.op === 'rowId' || o.op === 'groupId') && col(o.target)) {
        return cols.includes(o.target) ? cols : [...cols, o.target];
    }
    if (o.op === 'rename' && col(o.from) && col(o.to)) return renameCols(cols, o);
    const keys = keysOf(o);
    if (o.op === 'keep' && keys.length) return cols.filter((c) => keys.includes(c));
    if (o.op === 'remove' && keys.length) return cols.filter((c) => !keys.includes(c));
    return cols;
}

/**
 * Which columns exist after the first `uptoIndex` operations — each op row's
 * column options and the "column exists" warnings. Order-preserving, deduped.
 */
export function columnsAfterOps(baseColumns: unknown, ops: unknown, uptoIndex = Infinity): string[] {
    let cols = [...new Set(arr(baseColumns).filter(col))];
    const list = Array.isArray(ops) ? ops.slice(0, uptoIndex) : [];
    for (const o of list) {
        if (isObj(o)) cols = foldColumns(cols, o);
    }
    return cols;
}

function keepOnly(row: Obj, keys: string[]): Obj {
    const next: Obj = {};
    for (const k of keys) if (k in row) next[k] = row[k];
    return next;
}

function foldRow(row: Obj, o: Obj): Obj {
    if ((o.op === 'rowId' || o.op === 'groupId') && col(o.target)) return { ...row, [o.target]: 1 };
    if (o.op === 'rename' && col(o.from) && col(o.to) && o.from !== o.to) {
        if (!(o.from in row)) return row;
        const out = { ...row, [o.to]: row[o.from] };
        delete out[o.from];
        return out;
    }
    const keys = keysOf(o);
    if (o.op === 'keep') return keys.length ? keepOnly(row, keys) : row;
    if (o.op === 'remove') {
        const out = { ...row };
        for (const k of keys) delete out[k];
        return out;
    }
    return row;
}

/**
 * The same fold applied to ONE sample row, so the describer can show
 * downstream steps the post-operations shape. rowId/groupId targets become 1.
 */
export function applyOpsToSampleRow(row: unknown, ops: unknown): Obj {
    let out: Obj = { ...(isObj(row) ? row : {}) };
    for (const o of arr(ops)) {
        if (isObj(o)) out = foldRow(out, o);
    }
    return out;
}
