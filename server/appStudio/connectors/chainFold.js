// @typecheck strict
/**
 * The parts of one chain step (./chain.js applyChainStep) around the tool
 * calls: what the step asks for, the arguments bound from a row, the call for
 * one row under the budget, and folding every row's result back in: flat
 * rows, and in trace mode the rows at each grain.
 */

'use strict';

const { MAX_CONNECTOR_ROWS, isPlainObject: isPlain } = require('./shared');
const { readRowPath } = require('./dispatch');

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ tool: string, argsFrom: Record<string, unknown>, fixedArgs: Record<string, unknown>, merge: 'nest' | 'extend',
 *   alias: string, shortName: string, expandFrom: string | null, ownTable: boolean, opensChildGrain: boolean }} StepPlan
 *   what a chain step asks for, decided once and not per row
 * @typedef {{ row: Row, result: unknown, error?: string, skipped?: boolean, carried?: boolean }} RowResult
 * @typedef {{ trace: boolean, out: Row[], parentOut: Row[] | null, childOut: Row[] | null, grainIndexOf: number[] | null }} Sink
 *   where folded rows go: the flat output and, in trace mode, the grains
 * @typedef {{ row: Row, result: unknown, grainAt: number, grainRow: Row }} Place  one row's result and where its grain row sits
 */

/**
 * A plain object, as ./shared decides it.
 * @param {unknown} value
 * @returns {value is Row}
 */
const isPlainObject = (value) => isPlain(value);

/**
 * @param {{ tool?: unknown, argsFrom?: unknown, fixedArgs?: unknown, merge?: unknown, alias?: unknown, expand?: unknown, ownTable?: unknown }} step
 * @returns {StepPlan}
 */
function stepPlan(step) {
    const tool = typeof step.tool === 'string' ? step.tool : '';
    // Fan out over a field of the result (attachments), or keep the result as a
    // thing of its own beside the parent. Both open a new grain — a table of
    // their own — so they are decided once, not per row.
    const expandFrom = typeof step.expand === 'string' && step.expand ? step.expand : null;
    const ownTable = step.ownTable === true && !expandFrom;
    return {
        tool,
        argsFrom: isPlainObject(step.argsFrom) ? step.argsFrom : {},
        fixedArgs: isPlainObject(step.fixedArgs) ? step.fixedArgs : {},
        merge: step.merge === 'nest' ? 'nest' : 'extend',
        alias: typeof step.alias === 'string' && step.alias ? step.alias : /** @type {string} */ (tool.split('_').pop()),
        shortName: tool.split('_').slice(1).join('_') || tool,
        expandFrom,
        ownTable,
        opensChildGrain: !!expandFrom || ownTable,
    };
}

/**
 * The tool arguments of one row: the bound fields, then the pinned ones,
 * which still win, exactly as on the base step.
 * @param {Row} row
 * @param {StepPlan} plan
 */
function boundArgs(row, { argsFrom, fixedArgs }) {
    /** @type {Record<string, unknown>} */
    const bound = {};
    for (const [param, path] of Object.entries(argsFrom)) {
        const value = readRowPath(row, path);
        if (value === undefined || value === null) continue;
        // Only primitives cross into a tool call; an object would be a
        // silently malformed argument.
        if (typeof value === 'object') continue;
        bound[param] = value;
    }
    return { ...bound, ...fixedArgs };
}

/**
 * The call for one row, under the budget.
 * @param {Row} row
 * @param {StepPlan} plan
 * @param {{ remaining: number }} budget
 * @param {(args: Record<string, unknown>) => Promise<unknown>} call  the tool call
 * @returns {Promise<RowResult>}
 */
async function callForRow(row, plan, budget, call) {
    if (!isPlainObject(row)) return { row, result: null };
    // A row the previous step could not resolve is missing exactly the fields
    // this one binds from, so calling the tool for it would spend an upstream
    // call to learn nothing. It is carried through with its reason intact
    // rather than dropped — the author still sees which rows failed and why.
    if (row._error) return { row, result: null, carried: true };
    if (budget.remaining <= 0) return { row, result: null, skipped: true };
    budget.remaining -= 1;

    const args = boundArgs(row, plan);
    try {
        return { row, result: await call(args) };
    } catch (err) {
        // A missing connection is a setup problem, not a bad row — stamping
        // it on 500 rows would hide the one thing the author can fix.
        if (err?.code === 'connection_required') throw err;
        return { row, result: null, error: String(/** @type {Error} */ (err)?.message || err).slice(0, 200) };
    }
}

/**
 * Fold a payload onto a row. Who owns a colliding key depends on what the
 * step did.
 *
 *   enrich (no expand) — the ROW keeps its own fields; the result's
 *     collisions are prefixed with the tool. Enrichment must never
 *     overwrite the identity or watermark a sync depends on.
 *   expand            — the ELEMENT is the new row's subject (fanning
 *     out over attachments makes each row an attachment), so its fields
 *     win and the parent's collisions are preserved as `parent_<key>`.
 *     That is also what makes the next step bindable: `id` is the
 *     attachment, `parent_id` is still the message.
 * @param {StepPlan} plan
 * @param {Row} base
 * @param {unknown} payload
 * @param {boolean} fromExpand
 * @returns {Row}
 */
function foldOnto({ merge, alias, shortName }, base, payload, fromExpand) {
    if (merge === 'nest') return { ...base, [alias]: payload ?? null };
    if (!isPlainObject(payload)) return { ...base, [alias]: payload ?? null };
    const merged = { ...base };
    for (const [k, v] of Object.entries(payload)) {
        if (!Object.hasOwn(base, k)) { merged[k] = v; continue; }
        if (fromExpand) { merged[`parent_${k}`] = base[k]; merged[k] = v; }
        else { merged[`${shortName}_${k}`] = v; }
    }
    return merged;
}

/**
 * @param {Sink} sink
 * @param {Row} flatRow
 * @param {number} grainIdx  its index in the grain that is CURRENT after this step
 */
function pushOut(sink, flatRow, grainIdx) {
    sink.out.push(flatRow);
    if (sink.grainIndexOf) sink.grainIndexOf.push(grainIdx);
}

/**
 * A row that was not called, or whose call failed: it keeps its place in the
 * flat output with the reason on it. A carried row's grain entry keeps the
 * reason the earlier step wrote there.
 * @param {Sink} sink
 * @param {RowResult} entry
 * @param {{ grainAt: number, grainRow: Row, noChild: number }} at
 * @returns {boolean} whether the row was one of those
 */
function foldUncalled(sink, { row, error, skipped, carried }, { grainAt, grainRow, noChild }) {
    if (carried) { pushOut(sink, row, noChild); return true; }
    if (!skipped && !error) return false;
    const mark = skipped ? { _partial: true } : { _error: error };
    pushOut(sink, { ...row, ...mark }, noChild);
    if (sink.parentOut && grainAt >= 0) sink.parentOut[grainAt] = { ...grainRow, ...mark };
    return true;
}

/**
 * Fan out: one output row per element of the expanded list.
 *
 * An expanding step still returns fields ABOUT THE PARENT alongside the list
 * — gmail_read hands back the body as well as the attachments. Those belong on
 * the parent, so they are folded there rather than dropped or copied onto
 * every child.
 * @param {Sink} sink
 * @param {StepPlan & { expandFrom: string }} plan
 * @param {Place} place
 * @param {unknown[]} expandSource
 * @returns {boolean} whether rows were added (an empty list adds only the parent)
 */
function foldExpanded(sink, plan, { row, result, grainAt, grainRow }, expandSource) {
    const { expandFrom } = plan;
    const rest = isPlainObject(result)
        ? Object.fromEntries(Object.entries(result).filter(([k]) => k !== expandFrom))
        : null;
    const hasRest = !!rest && Object.keys(rest).length > 0;
    const enrichedParent = hasRest ? foldOnto(plan, row, rest, false) : row;
    if (sink.parentOut && grainAt >= 0 && hasRest) sink.parentOut[grainAt] = foldOnto(plan, grainRow, rest, false);

    if (expandSource.length === 0) { pushOut(sink, enrichedParent, -1); return false; }
    for (const item of expandSource) {
        const element = isPlainObject(item) ? item : { [expandFrom]: item };
        // The CHILD grain is the element and nothing else. Copying the
        // parent's columns onto it is exactly the duplication that related
        // tables exist to avoid — the link is the relation column, resolved
        // from `_parentIndex` at write time. Leading underscore → inferFields
        // and the column mapper both ignore it.
        const childIdx = sink.childOut ? sink.childOut.push({ ...element, _parentIndex: grainAt }) - 1 : -1;
        // The FLAT view stays merged: a grid bound straight to the connector
        // wants one wide row, and the next chain step binds against
        // `parent_<key>`.
        pushOut(sink, foldOnto(plan, enrichedParent, element, true), childIdx);
        if (sink.out.length >= MAX_CONNECTOR_ROWS) break;
    }
    return true;
}

/**
 * The result is its own thing, kept beside the parent instead of widening it:
 * one child row per parent row. The parent grain is left exactly as it was —
 * that is the whole point, otherwise the same columns would live in two
 * tables. The flat view still merges, so `Test it`, a grid bound straight to
 * the connector, and a later step's bindings behave as before.
 * @param {Sink} sink
 * @param {StepPlan} plan
 * @param {Place} place
 */
function foldOwnTable(sink, plan, { row, result, grainAt }) {
    let childIdx = -1;
    if (sink.childOut) {
        /** @type {Row} */
        const element = isPlainObject(result) ? { ...result } : { [plan.alias]: result ?? null };
        element._parentIndex = grainAt;
        childIdx = sink.childOut.push(element) - 1;
    }
    pushOut(sink, foldOnto(plan, row, result, false), childIdx);
}

/**
 * One row's outcome into the flat output and the grains.
 * @param {Sink} sink
 * @param {StepPlan} plan
 * @param {RowResult} entry
 * @param {{ grainAt: number, grainRow: Row }} at  the row as its GRAIN holds it — free of the parent columns the flat
 *   view carries — so enriching a child grain doesn't re-import them
 * @returns {boolean} whether the row cap is checked after this row
 */
function foldRow(sink, plan, entry, { grainAt, grainRow }) {
    const { row, result } = entry;
    // A row that produced nothing has no place in the child grain, so it maps
    // to -1; the parent grain still gets its entry, carrying the reason.
    const noChild = plan.opensChildGrain ? -1 : grainAt;
    if (foldUncalled(sink, entry, { grainAt, grainRow, noChild })) return false;

    const { expandFrom } = plan;
    const expandSource = expandFrom
        ? (readRowPath(isPlainObject(result) ? result : {}, expandFrom) ?? readRowPath(row, expandFrom))
        : null;
    const place = { row, result, grainAt, grainRow };
    if (expandFrom && Array.isArray(expandSource)) return foldExpanded(sink, { ...plan, expandFrom }, place, expandSource);
    if (plan.ownTable) { foldOwnTable(sink, plan, place); return true; }
    // `_parentIndex`, when the grain row carries one, survives the fold —
    // it is on the base, not the payload.
    if (sink.parentOut && grainAt >= 0) sink.parentOut[grainAt] = foldOnto(plan, grainRow, result, false);
    pushOut(sink, foldOnto(plan, row, result, false), grainAt);
    return true;
}

/**
 * @param {boolean} trace
 * @param {boolean} opensChildGrain
 * @param {Row[]} baseGrain  the incoming grain
 * @returns {Sink}
 */
function newSink(trace, opensChildGrain, baseGrain) {
    return {
        trace,
        out: [],
        parentOut: trace ? baseGrain.slice() : null,
        childOut: (trace && opensChildGrain) ? [] : null,
        grainIndexOf: trace ? [] : null,
    };
}

/**
 * Fold every row's result back in.
 *
 * In trace mode the rows at each GRAIN are kept as well: `parentRows` is the
 * incoming grain with this step's enrichment applied in place, `childRows`
 * the rows of the grain this step opens. Those two are what a related pair of
 * tables is stored from — the flat rows would duplicate every parent field
 * once per child.
 *
 * The parent grain starts as a COPY of the incoming grain and is updated by
 * grain index, never rebuilt row-by-row from the flat output: after an expand
 * the flat rows outnumber their grain, so appending per flat row would grow
 * the parent table by one junk row per child.
 *
 * `grainIndexOf` is tracked explicitly rather than assumed positional: a row
 * that errored, that was skipped for budget, or that expanded over an empty
 * list still produces a flat row but no grain row, and from there on every
 * later step would bind against the wrong parent.
 * @param {StepPlan} plan
 * @param {RowResult[]} results
 * @param {{ trace: boolean, rows: Row[], grainRows: Row[] | null, rowGrainIndex: number[] | null }} grains
 */
function foldResults(plan, results, { trace, rows, grainRows, rowGrainIndex }) {
    const sink = newSink(trace, plan.opensChildGrain, grainRows || rows);
    for (const [parentIndex, entry] of results.entries()) {
        const grainAt = rowGrainIndex ? (rowGrainIndex[parentIndex] ?? -1) : parentIndex;
        const grainRow = (grainRows && grainAt >= 0 && grainRows[grainAt]) || entry.row;
        if (foldRow(sink, plan, entry, { grainAt, grainRow }) && sink.out.length >= MAX_CONNECTOR_ROWS) break;
    }
    const capped = sink.out.slice(0, MAX_CONNECTOR_ROWS);
    if (!sink.grainIndexOf) return capped;
    return {
        rows: capped,
        parentRows: sink.parentOut,
        childRows: (sink.childOut && sink.childOut.length) ? sink.childOut.slice(0, MAX_CONNECTOR_ROWS) : null,
        grainIndexOf: sink.grainIndexOf.slice(0, capped.length),
    };
}

module.exports = { stepPlan, callForRow, foldResults };
