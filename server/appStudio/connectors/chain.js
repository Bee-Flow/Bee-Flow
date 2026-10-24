// @typecheck
/**
 * Connector CHAINS: follow-up tools run once per row, their parameters bound
 * to fields of the row, under the hard call budget (see MAX_CHAIN_CALLS in
 * ./shared.js: depth multiplies calls made with the owner's credentials).
 */

'use strict';

const {
    MAX_CONNECTOR_ROWS, MAX_CHAIN_CONCURRENCY, isPlainObject,
} = require('./shared');
const { readRowPath, dispatchTool } = require('./dispatch');

// Run `jobs` with a small fixed concurrency. Deliberately hand-rolled rather
// than Promise.all over everything: an owner's Gmail account must not receive
// 500 simultaneous reads because their app has 500 rows.
async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Apply one chain step to every row: call `step.tool` once per row with its
 * parameters bound to that row, then fold the result back in.
 *
 *   merge 'extend' — spread the result's own fields onto the row. On a key
 *                    collision the incoming field is prefixed with the tool's
 *                    short name, so a follow-up can never silently overwrite the
 *                    identity or watermark the sync engine depends on.
 *   merge 'nest'   — put the whole result under `row[alias]`.
 *   expand         — fan out: one output row per element of that field, which is
 *                    how "one row per attachment" is expressed.
 *   ownTable       — the step's result is a THING OF ITS OWN, stored beside the
 *                    parent rather than widening it: one child row per parent
 *                    row, joined by a relation column. Only affects the traced
 *                    per-grain view; the flat output stays merged either way.
 *
 * A single row's failure is recorded on that row (`_error`) instead of failing
 * the run: one unreadable message must not empty a table of 400 good ones. The
 * BASE step has no such tolerance — it still throws (see runIntegrationChain).
 */
async function applyChainStep(step, rows, budget, exec, deps, app, connector, {
    trace = false, grainRows = null, rowGrainIndex = null,
} = {}) {
    const tool = typeof step.tool === 'string' ? step.tool : '';
    if (!tool) return rows;
    const argsFrom = isPlainObject(step.argsFrom) ? step.argsFrom : {};
    const fixedArgs = isPlainObject(step.fixedArgs) ? step.fixedArgs : {};
    const merge = step.merge === 'nest' ? 'nest' : 'extend';
    const alias = typeof step.alias === 'string' && step.alias ? step.alias : tool.split('_').pop();
    const shortName = tool.split('_').slice(1).join('_') || tool;

    // Fan out over a field of the result (attachments), or keep the result as a
    // thing of its own beside the parent. Both open a new grain — a table of
    // their own — so they are decided once, not per row.
    const expandFrom = typeof step.expand === 'string' && step.expand ? step.expand : null;
    const ownTable = step.ownTable === true && !expandFrom;
    const opensChildGrain = !!expandFrom || ownTable;

    const results = await mapWithConcurrency(rows, MAX_CHAIN_CONCURRENCY, async (row) => {
        if (!isPlainObject(row)) return { row, result: null };
        // A row the previous step could not resolve is missing exactly the fields
        // this one binds from, so calling the tool for it would spend an upstream
        // call to learn nothing. It is carried through with its reason intact
        // rather than dropped — the author still sees which rows failed and why.
        if (row._error) return { row, result: null, carried: true };
        if (budget.remaining <= 0) return { row, result: null, skipped: true };
        budget.remaining -= 1;

        const bound = {};
        for (const [param, path] of Object.entries(argsFrom)) {
            const value = readRowPath(row, path);
            if (value === undefined || value === null) continue;
            // Only primitives cross into a tool call; an object would be a
            // silently malformed argument.
            if (typeof value === 'object') continue;
            bound[param] = value;
        }
        // Pinned args still win, exactly as on the base step.
        const args = { ...bound, ...fixedArgs };
        try {
            return { row, result: await dispatchTool(tool, args, exec, deps, app, connector) };
        } catch (err) {
            // A missing connection is a setup problem, not a bad row — stamping
            // it on 500 rows would hide the one thing the author can fix.
            if (err?.code === 'connection_required') throw err;
            return { row, result: null, error: String(err?.message || err).slice(0, 200) };
        }
    });

    const out = [];
    // In trace mode we additionally keep the rows at each GRAIN: `parentOut` is
    // the incoming grain with this step's enrichment applied in place, `childOut`
    // the rows of the grain this step opens. Those two are what a related pair of
    // tables is stored from — the flat `out` would duplicate every parent field
    // once per child.
    //
    // parentOut starts as a COPY of the incoming grain and is updated by grain
    // index, never rebuilt row-by-row from the flat output: after an expand the
    // flat rows outnumber their grain, so appending per flat row would grow the
    // parent table by one junk row per child.
    const baseGrain = grainRows || rows;
    const parentOut = trace ? baseGrain.slice() : null;
    const childOut = (trace && opensChildGrain) ? [] : null;
    // out[i] → its index in the grain that is CURRENT after this step. Tracked
    // explicitly rather than assumed positional: a row that errored, that was
    // skipped for budget, or that expanded over an empty list still produces a
    // flat row but no grain row, and from there on every later step would bind
    // against the wrong parent.
    const grainIndexOf = trace ? [] : null;
    const pushOut = (flatRow, grainIdx) => {
        out.push(flatRow);
        if (grainIndexOf) grainIndexOf.push(grainIdx);
    };

    for (const [parentIndex, entry] of results.entries()) {
        const { row, result, error, skipped, carried } = entry;
        // The row as its GRAIN holds it — free of the parent columns the flat
        // view carries — so enriching a child grain doesn't re-import them.
        const grainAt = rowGrainIndex ? (rowGrainIndex[parentIndex] ?? -1) : parentIndex;
        const grainRow = (grainRows && grainAt >= 0 && grainRows[grainAt]) || row;
        // A row that produced nothing has no place in the child grain, so it maps
        // to -1; the parent grain still gets its entry, carrying the reason.
        const noChild = opensChildGrain ? -1 : grainAt;
        // Already failed upstream: the grain entry keeps the reason the earlier
        // step wrote there, so nothing to update here.
        if (carried) { pushOut(row, noChild); continue; }
        if (skipped) { pushOut({ ...row, _partial: true }, noChild); if (trace && grainAt >= 0) parentOut[grainAt] = { ...grainRow, _partial: true }; continue; }
        if (error) { pushOut({ ...row, _error: error }, noChild); if (trace && grainAt >= 0) parentOut[grainAt] = { ...grainRow, _error: error }; continue; }

        const expandSource = expandFrom
            ? (readRowPath(isPlainObject(result) ? result : {}, expandFrom) ?? readRowPath(row, expandFrom))
            : null;

        // Who owns a colliding key depends on what the step did.
        //
        //   enrich (no expand) — the ROW keeps its own fields; the result's
        //     collisions are prefixed with the tool. Enrichment must never
        //     overwrite the identity or watermark a sync depends on.
        //   expand            — the ELEMENT is the new row's subject (fanning
        //     out over attachments makes each row an attachment), so its fields
        //     win and the parent's collisions are preserved as `parent_<key>`.
        //     That is also what makes the next step bindable: `id` is the
        //     attachment, `parent_id` is still the message.
        const foldOnto = (base, payload, fromExpand) => {
            if (merge === 'nest') return { ...base, [alias]: payload ?? null };
            if (!isPlainObject(payload)) return { ...base, [alias]: payload ?? null };
            const merged = { ...base };
            for (const [k, v] of Object.entries(payload)) {
                if (!Object.hasOwn(base, k)) { merged[k] = v; continue; }
                if (fromExpand) { merged[`parent_${k}`] = base[k]; merged[k] = v; }
                else { merged[`${shortName}_${k}`] = v; }
            }
            return merged;
        };

        if (expandFrom && Array.isArray(expandSource)) {
            // An expanding step still returns fields ABOUT THE PARENT alongside
            // the list — gmail_read hands back the body as well as the
            // attachments. Those belong on the parent, so they are folded there
            // rather than dropped (they used to be) or copied onto every child.
            const rest = isPlainObject(result)
                ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== expandFrom))
                : null;
            const enrichedParent = rest && Object.keys(rest).length ? foldOnto(row, rest, false) : row;
            if (trace && grainAt >= 0 && rest && Object.keys(rest).length) {
                parentOut[grainAt] = foldOnto(grainRow, rest, false);
            }

            if (expandSource.length === 0) { pushOut(enrichedParent, -1); continue; }
            for (const item of expandSource) {
                const element = isPlainObject(item) ? item : { [expandFrom]: item };
                let childIdx = -1;
                if (trace) {
                    // The CHILD grain is the element and nothing else. Copying the
                    // parent's columns onto it is exactly the duplication that
                    // related tables exist to avoid — the link is the relation
                    // column, resolved from `_parentIndex` at write time.
                    // Leading underscore → inferFields and the column mapper
                    // both ignore it.
                    childIdx = childOut.push({ ...element, _parentIndex: grainAt }) - 1;
                }
                // The FLAT view stays merged: a grid bound straight to the
                // connector wants one wide row, and the next chain step binds
                // against `parent_<key>`.
                pushOut(foldOnto(enrichedParent, element, true), childIdx);
                if (out.length >= MAX_CONNECTOR_ROWS) break;
            }
        } else if (ownTable) {
            // The result is its own thing, kept beside the parent instead of
            // widening it: one child row per parent row. The parent grain is left
            // exactly as it was — that is the whole point, otherwise the same
            // columns would live in two tables.
            let childIdx = -1;
            if (trace) {
                // parentOut[grainAt] is already the untouched grain row.
                const element = isPlainObject(result) ? { ...result } : { [alias]: result ?? null };
                element._parentIndex = grainAt;
                childIdx = childOut.push(element) - 1;
            }
            // The flat view still merges, so `Test it`, a grid bound straight to
            // the connector, and a later step's bindings behave as before.
            pushOut(foldOnto(row, result, false), childIdx);
        } else {
            // `_parentIndex`, when the grain row carries one, survives the fold —
            // it is on the base, not the payload.
            if (trace && grainAt >= 0) parentOut[grainAt] = foldOnto(grainRow, result, false);
            pushOut(foldOnto(row, result, false), grainAt);
        }
        if (out.length >= MAX_CONNECTOR_ROWS) break;
    }
    const capped = out.slice(0, MAX_CONNECTOR_ROWS);
    if (!trace) return capped;
    return {
        rows: capped,
        parentRows: parentOut,
        childRows: (childOut && childOut.length) ? childOut.slice(0, MAX_CONNECTOR_ROWS) : null,
        grainIndexOf: grainIndexOf.slice(0, capped.length),
    };
}

module.exports = { mapWithConcurrency, applyChainStep };
