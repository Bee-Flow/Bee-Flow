// @typecheck
'use strict';
/**
 * A structural diff of two JSON values, for comparing what two runs of an
 * automation produced (automation/testing/runCompare.js).
 *
 *   diffJson(a, b, { ignorePaths, maxChanges, differs, ctx })
 *     → Promise<{ changes: Change[], truncated: boolean }>
 *
 * Change = { path, change: 'added'|'removed'|'changed'|'type_changed', before?, after? }
 * `before` is the value in `a`, `after` the value in `b`; both are JSON text
 * cut to 200 characters, so a change never carries more than a glance of data.
 *
 *  - Paths use the value-path grammar of shared/expr (`a.b[2].c`, `a["x y"]`),
 *    so a path from here can be pasted into a binding. The root is ''.
 *  - Arrays are compared by index; a length difference is ONE extra change at
 *    `<path>.length`.
 *  - The meta keys a dry run stamps on an output (_dryRun and friends) and the
 *    truncation sentinel's full-output reference are skipped at any depth: they
 *    describe HOW the run went, not what it produced.
 *  - `ignorePaths` skips an exact path and everything under it.
 *  - An object with a string `kind` is first offered to the output-differ
 *    registry (outputDiffers.js): a handle to a file or table is compared by
 *    what it stands for, not by its id.
 *  - At most `maxChanges` changes (0 = no limit); then `truncated` is true.
 *  - A depth guard of 64 stops self-similar junk.
 */

const { appendKey } = require('../../shared/expr/index.mjs');
const outputDiffers = require('./outputDiffers');
const { FULL_OUTPUT_REF } = require('../../core/automationModel/payloadTruncation');

const { cutValue } = outputDiffers;

const MAX_DEPTH = 64;

/** Keys a run stamps on an output that say how it ran, not what it made. */
const META_KEYS = Object.freeze(new Set([
    '_dryRun', '_dryRunSyntheticInputs', '_dryRunSynthesised', '_dryRunFallback',
    'wouldHaveCalled', '_fromScenario', 'httpCalls', FULL_OUTPUT_REF,
]));

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The JSON kind of a value. */
function kindOf(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    return Array.isArray(v) ? 'array' : typeof v;
}

/** Exact JSON equality; null when a side cannot be serialised. */
function sameJson(x, y) {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch { return null; }
}

/** A path relative to a handle, put under the handle's own path. */
function joinPath(base, rel) {
    if (!base) return rel;
    if (!rel) return base;
    return rel.startsWith('[') ? `${base}${rel}` : `${base}.${rel}`;
}

/** @param {string[]} ignorePaths */
function makeIgnore(ignorePaths) {
    const list = (Array.isArray(ignorePaths) ? ignorePaths : []).filter(p => typeof p === 'string' && p);
    if (!list.length) return () => false;
    return (path) => list.some(p => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
}

/**
 * @param {any} a
 * @param {any} b
 * @param {{ ignorePaths?: string[], maxChanges?: number, differs?: { differFor: (v: any) => any }, ctx?: object }} [opts]
 * @returns {Promise<{ changes: Array<{ path: string, change: string, before?: string, after?: string }>, truncated: boolean }>}
 */
async function diffJson(a, b, opts = {}) {
    const { ignorePaths = [], maxChanges = 200, differs = outputDiffers, ctx = {} } = opts;
    const ignored = makeIgnore(ignorePaths);
    const changes = [];
    let truncated = false;

    /** Record one change; false once the cap is reached. */
    const push = (change) => {
        if (maxChanges > 0 && changes.length >= maxChanges) { truncated = true; return false; }
        changes.push(change);
        return true;
    };
    const full = () => truncated;

    async function viaDiffer(da, va, vb, path) {
        let out;
        try {
            out = await da.diff(va, vb, { ...ctx, path });
        } catch {
            return false; // the generic walk still gives an honest answer
        }
        for (const c of out?.changes || []) {
            const p = joinPath(path, c.path);
            if (ignored(p)) continue;
            if (!push({ ...c, path: p })) break;
        }
        return true;
    }

    async function walkObjects(va, vb, path, depth) {
        const keys = Object.keys(va).filter(k => !META_KEYS.has(k));
        for (const k of Object.keys(vb)) if (!META_KEYS.has(k) && !Object.prototype.hasOwnProperty.call(va, k)) keys.push(k);
        for (const k of keys) {
            if (full()) return;
            const p = appendKey(path, k);
            if (ignored(p)) continue;
            const inA = Object.prototype.hasOwnProperty.call(va, k);
            const inB = Object.prototype.hasOwnProperty.call(vb, k);
            if (inA && !inB) push({ path: p, change: 'removed', before: cutValue(va[k]) });
            else if (!inA && inB) push({ path: p, change: 'added', after: cutValue(vb[k]) });
            else await walk(va[k], vb[k], p, depth + 1);
        }
    }

    async function walkArrays(va, vb, path, depth) {
        const common = Math.min(va.length, vb.length);
        for (let i = 0; i < common && !full(); i++) {
            const p = appendKey(path, i);
            if (!ignored(p)) await walk(va[i], vb[i], p, depth + 1);
        }
        if (va.length !== vb.length && !full()) {
            const p = appendKey(path, 'length');
            if (!ignored(p)) push({ path: p, change: 'changed', before: cutValue(va.length), after: cutValue(vb.length) });
        }
    }

    async function walk(va, vb, path, depth) {
        if (full()) return;
        const ka = kindOf(va);
        const kb = kindOf(vb);
        if (ka !== kb) {
            push({ path, change: 'type_changed', before: cutValue(va), after: cutValue(vb) });
            return;
        }
        if (ka !== 'object' && ka !== 'array') {
            if (va !== vb && !(Number.isNaN(va) && Number.isNaN(vb))) {
                push({ path, change: 'changed', before: cutValue(va), after: cutValue(vb) });
            }
            return;
        }
        if (depth >= MAX_DEPTH) {
            if (sameJson(va, vb) === false) push({ path, change: 'changed', before: cutValue(va), after: cutValue(vb) });
            return;
        }
        if (isObject(va) && typeof va.kind === 'string' && typeof vb.kind === 'string') {
            const da = differs.differFor(va);
            if (da && da === differs.differFor(vb) && await viaDiffer(da, va, vb, path)) return;
        }
        if (ka === 'array') await walkArrays(va, vb, path, depth);
        else await walkObjects(va, vb, path, depth);
    }

    await walk(a, b, '', 0);
    return { changes, truncated };
}

module.exports = { diffJson, META_KEYS, MAX_DEPTH };
