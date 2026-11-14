// @typecheck
/**
 * Connector CHAINS: follow-up tools run once per row, their parameters bound
 * to fields of the row, under the hard call budget (see MAX_CHAIN_CALLS in
 * ./shared.js: depth multiplies calls made with the owner's credentials).
 */

'use strict';

const { MAX_CHAIN_CONCURRENCY } = require('./shared');
const { dispatchTool } = require('./dispatch');
const { stepPlan, callForRow, foldResults } = require('./chainFold');

// Run `jobs` with a small fixed concurrency. Deliberately hand-rolled rather
// than Promise.all over everything: an owner's Gmail account must not receive
// 500 simultaneous reads because their app has 500 rows.
/**
 * @param {number} limit
 */
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
 * @param {{ remaining: number; }} budget
 */
async function applyChainStep(step, rows, budget, exec, deps, app, connector, {
    trace = false, grainRows = null, rowGrainIndex = null,
} = {}) {
    const plan = stepPlan(step);
    if (!plan.tool) return rows;
    const results = await mapWithConcurrency(rows, MAX_CHAIN_CONCURRENCY, (row) =>
        callForRow(row, plan, budget, (args) => dispatchTool(plan.tool, args, exec, deps, app, connector)));
    return foldResults(plan, results, { trace, rows, grainRows, rowGrainIndex });
}

module.exports = { mapWithConcurrency, applyChainStep };

/**
 * @typedef {{ rows: import('./shared').ConnectorRow[], parentRows: import('./shared').ConnectorRow[] | null, childRows: import('./shared').ConnectorRow[] | null, grainIndexOf: number[] | null }} ChainTrace  What a traced step returns: the flat rows plus the rows at each grain.
 */
