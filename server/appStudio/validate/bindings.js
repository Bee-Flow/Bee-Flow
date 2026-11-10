// @typecheck
/**
 * App Studio validator — the binding grammar: binding objects on props and
 * step fields, and the record/records/aggregate filter & sort descriptors.
 */

'use strict';

const { BINDING_KINDS, FORMULA_SCOPE_ROOTS } = require('../componentSpecs');
const { pickClosestId } = require('../../automation/validate/helpers');
const { relativePathTokens, suggestRelativeSpelling } = require('../../core/automationModel/refPaths');
const { isObject } = require('./shared');
const { MAX_ORDER_BY } = require('../componentSpecs');
const { validateBindingFilter } = require('./bindingFilters');
const { validateFormula } = require('./formulas');
const {
    checkTableRef,
    checkTableSource,
    checkConnectorRef,
    validateConnectorParams,
    checkDatasetRef,
    checkFieldRef,
} = require('./refs');

// actionResult and record paths are RELATIVE to the result / the row and use
// the one path grammar the automation runtime and the app's resolver use
// (shared/expr/path.mjs): `items.0.name` and `items[0].name` alike,
// `body["@odata.nextLink"]`, `fields["Story Points"]`, `headers.Content-Type`,
// `rows[*].title`, `headers[name="Subject"].value`. A dotted-identifier regex
// here would refuse what the live preview had just resolved (a 422 on save),
// and left keys like `@odata.nextLink` unbindable.
/**
 * @param {string} at
 */
function checkBindingPath(p, at, ctx) {
    if (p === undefined || p === null || p === '') return;
    if (typeof p === 'string' && relativePathTokens(p) !== null) return;
    const suggestion = typeof p === 'string' ? suggestRelativeSpelling(p) : null;
    ctx.pushE({
        code: 'binding.path_invalid', severity: 'error', path: at,
        message: `Binding path ${JSON.stringify(p)} is invalid.`,
        hint: suggestion
            ? `Write it as ${suggestion} — a key with spaces or symbols goes in ["…"], a position in a list in [0] (or .0).`
            : 'Use dots between names, [0] (or .0) for a position in a list and ["…"] around a key with spaces or symbols, e.g. items[0]["Story Points"].',
    });
}

/**
 * `orderBy`: 1..MAX_ORDER_BY { field, dir? } entries, each field once. For an
 * aggregate the fields are its output columns (`allowedAliases`).
 * @param {string} path
 * @param {string} label
 */
function validateBindingOrderBy(value, path, ctx, label, allowedAliases) {
    const { pushE } = ctx;
    const orderBy = value.orderBy;
    if (!Array.isArray(orderBy) || orderBy.length === 0 || orderBy.length > MAX_ORDER_BY) {
        pushE({ code: 'binding.sort_invalid', severity: 'error', path, message: `${label} orderBy must be a list of 1 to ${MAX_ORDER_BY} { field, dir? } entries.`, hint: 'e.g. [{ "field": "status", "dir": "asc" }, { "field": "due", "dir": "desc" }].' });
        return;
    }
    if (value.sort !== undefined && value.sort !== null) {
        pushE({ code: 'binding.sort_invalid', severity: 'error', path, message: `${label} has both sort and orderBy.`, hint: 'Keep orderBy (it sorts on every column it lists) and remove sort.' });
    }
    validateBindingSort(orderBy, path, ctx, value.tableId, label, allowedAliases);
    // A groupBy or aggregates formula names its output columns only when it runs.
    const isFormula = (/** @type {unknown} */ v) => isObject(v) && /** @type {{ kind?: unknown }} */ (v).kind === 'formula';
    const strictAliases = Boolean(allowedAliases) && !isFormula(value.groupBy) && !isFormula(value.aggregates);
    const seen = new Set();
    orderBy.forEach((entry, i) => {
        if (!isObject(entry) || typeof entry.field !== 'string') return;
        if (strictAliases && !allowedAliases.has(entry.field)) {
            pushE({ code: 'binding.sort_invalid', severity: 'error', path: `${path}[${i}].field`, message: `${label} orderBy names ${JSON.stringify(entry.field)}, which is not one of its output columns.`, hint: `Use one of: ${Array.from(allowedAliases).join(', ')}.` });
        }
        if (seen.has(entry.field)) pushE({ code: 'binding.sort_invalid', severity: 'error', path: `${path}[${i}].field`, message: `orderBy names ${JSON.stringify(entry.field)} twice.`, hint: 'List each field once.' });
        seen.add(entry.field);
    });
}

/**
 * The column names an aggregate descriptor produces. Mirrors the alias
 * derivation in queryCompiler.compileAggregate, so what validates is what runs.
 */
function aggregateAliases(binding) {
    const out = new Set();
    for (const g of Array.isArray(binding.groupBy) ? binding.groupBy : []) {
        if (!isObject(g)) continue;
        if (typeof g.as === 'string' && g.as) out.add(g.as);
        else if (typeof g.field === 'string' && g.field) out.add(g.bucket ? `${g.field}_${g.bucket}` : g.field);
    }
    for (const a of Array.isArray(binding.aggregates) ? binding.aggregates : []) {
        if (!isObject(a)) continue;
        if (typeof a.as === 'string' && a.as) out.add(a.as);
        else if (typeof a.fn === 'string') out.add(`${a.fn}_${a.field && a.field !== '*' ? a.field : 'all'}`);
    }
    return out;
}

/**
 * `allowedAliases` exists for aggregate bindings: their result columns are the
 * aliases the descriptor declares (count, median, hour), not columns on the
 * table. The compiler already sorts by those, so rejecting them here would be
 * stricter than the query that actually runs.
 * @param {string} path
 * @param {string} label
 */
function validateBindingSort(sort, path, ctx, tableId, label, allowedAliases = null) {
    const { pushE } = ctx;
    const entries = Array.isArray(sort) ? sort : [sort];
    entries.forEach((entry, i) => {
        const p = Array.isArray(sort) ? `${path}[${i}]` : path;
        if (!isObject(entry)) {
            pushE({ code: 'binding.sort_invalid', severity: 'error', path: p, message: `${label} sort must be { field, dir? } entries.`, hint: 'e.g. [{ "field": "created_at", "dir": "desc" }].' });
            return;
        }
        if (typeof entry.field !== 'string' || !entry.field) {
            pushE({ code: 'binding.sort_invalid', severity: 'error', path: `${p}.field`, message: 'Each sort entry needs a non-empty string `field`.', hint: 'Use a field key from the bound table.' });
        } else if (!(allowedAliases && allowedAliases.has(entry.field))) {
            checkFieldRef(tableId, entry.field, `${p}.field`, ctx, `${label} sort`);
        }
        const dir = entry.dir !== undefined ? entry.dir : entry.direction;
        if (dir !== undefined && dir !== null && !(typeof dir === 'string' && ['asc', 'desc'].includes(dir.toLowerCase()))) {
            pushE({ code: 'binding.sort_invalid', severity: 'error', path: `${p}.dir`, message: `Sort dir ${JSON.stringify(dir)} is invalid.`, hint: 'Use "asc" or "desc" (default desc).' });
        }
    });
}

/**
 * @param {string} key
 * @param {string} path
 */
function validateBinding(key, value, path, ctx) {
    const { pushE, actionIds } = ctx;
    if (!isObject(value)) {
        pushE({ code: 'binding.invalid', severity: 'error', path, message: `\`${key}\` must be a binding object.`, hint: `Use one of: ${BINDING_KINDS.map((k) => `{kind:'${k}', …}`).join(', ')}.` });
        return;
    }
    if (!BINDING_KINDS.includes(value.kind)) {
        pushE({ code: 'binding.kind_invalid', severity: 'error', path: `${path}.kind`, message: `Unknown binding kind ${JSON.stringify(value.kind)}.`, hint: `Use one of: ${BINDING_KINDS.join(', ')}.` });
        return;
    }
    if (value.kind === 'actionResult') {
        if (typeof value.actionId !== 'string' || !actionIds.has(value.actionId)) {
            const suggestion = pickClosestId(value.actionId, Array.from(actionIds));
            pushE({ code: 'binding.action_unresolved', severity: 'error', path: `${path}.actionId`, message: `Binding references unknown action ${JSON.stringify(value.actionId)}.`, hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first.' });
        }
        checkBindingPath(value.path, `${path}.path`, ctx);
    }
    // v2 binding kinds
    if (value.kind === 'formula') {
        validateFormula(value.expr, `${path}.expr`, ctx, FORMULA_SCOPE_ROOTS);
    }
    if (value.kind === 'record' || value.kind === 'records' || value.kind === 'aggregate') {
        const label = `${value.kind} binding`;
        checkTableRef(value.tableId, `${path}.tableId`, ctx, label);
        // …and then the second question, for the second kind of table: if this table fetches its rows
        // from a Studio datatable, does that datatable still exist? This is the screen that stays empty
        // if the answer is no, so it has to be said by name here. A table with its own storage passes
        // through undisturbed.
        checkTableSource(value.tableId, `${path}.tableId`, ctx, label);
        if (value.filter !== undefined && value.filter !== null) validateBindingFilter(value.filter, `${path}.filter`, ctx, value.tableId, label);
        // An aggregate may sort by the columns it produces, which is what the
        // compiler does too.
        const aggAliases = value.kind === 'aggregate' ? aggregateAliases(value) : null;
        if (value.sort !== undefined && value.sort !== null) validateBindingSort(value.sort, `${path}.sort`, ctx, value.tableId, label, aggAliases);
        if (value.orderBy !== undefined && value.orderBy !== null) validateBindingOrderBy(value, `${path}.orderBy`, ctx, label, aggAliases);
        if (value.limit !== undefined && value.limit !== null && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1)) {
            pushE({ code: 'binding.limit_invalid', severity: 'error', path: `${path}.limit`, message: `${label} limit must be a positive integer.`, hint: 'Use an integer ≥ 1, or omit it.' });
        }
    }
    if (value.kind === 'record') {
        checkBindingPath(value.path, `${path}.path`, ctx);
    }
    if (value.kind === 'aggregate') {
        const { AGG_FNS, DATE_BUCKETS } = require('../dataModel');
        // groupBy/aggregates may be a FORMULA rather than a literal list — a
        // saved report supplying the question at runtime. The expression is
        // parse-compiled here (never executed) and the per-entry field/function
        // checks below simply do not apply: the fields it will name are not
        // knowable until it runs. They are still checked, later and for real,
        // by the server — compileAggregate rejects any field that is not a
        // column of the table, any alias that is not an identifier, and any
        // function outside AGG_FNS, with the viewer's RLS filter ANDed in.
        const dynamicGroupBy = isObject(value.groupBy) && value.groupBy.kind === 'formula';
        const dynamicAggregates = isObject(value.aggregates) && value.aggregates.kind === 'formula';
        if (dynamicGroupBy) validateFormula(value.groupBy.expr, `${path}.groupBy.expr`, ctx, FORMULA_SCOPE_ROOTS);
        if (dynamicAggregates) validateFormula(value.aggregates.expr, `${path}.aggregates.expr`, ctx, FORMULA_SCOPE_ROOTS);
        const groupBy = Array.isArray(value.groupBy) ? value.groupBy : [];
        const aggregates = Array.isArray(value.aggregates) ? value.aggregates : [];
        if (!dynamicGroupBy && !dynamicAggregates && !groupBy.length && !aggregates.length) {
            pushE({
                code: 'binding.aggregate_empty', severity: 'error', path,
                message: 'An aggregate binding needs at least one groupBy or aggregate.',
                hint: 'Add e.g. aggregates: [{ fn: "count", as: "count" }].',
            });
        }
        groupBy.forEach((g, i) => {
            if (!isObject(g)) return;
            checkFieldRef(value.tableId, g.field, `${path}.groupBy[${i}].field`, ctx, 'aggregate binding', { codePrefix: 'binding' });
            if (g.bucket !== undefined && g.bucket !== null && !DATE_BUCKETS.includes(g.bucket)) {
                pushE({
                    code: 'binding.aggregate_invalid', severity: 'error', path: `${path}.groupBy[${i}].bucket`,
                    message: `Unknown date bucket ${JSON.stringify(g.bucket)}.`,
                    hint: `Use one of: ${DATE_BUCKETS.join(', ')}.`,
                });
            }
        });
        aggregates.forEach((a, i) => {
            if (!isObject(a)) return;
            if (!AGG_FNS.includes(a.fn)) {
                pushE({
                    code: 'binding.aggregate_invalid', severity: 'error', path: `${path}.aggregates[${i}].fn`,
                    message: `Unknown aggregate function ${JSON.stringify(a.fn)}.`,
                    hint: `Use one of: ${AGG_FNS.join(', ')}.`,
                });
                return;
            }
            // count may fold whole rows; everything else needs a column, and a
            // percentile needs one it can rank.
            if (a.fn !== 'count' && (a.field === undefined || a.field === null || a.field === '*')) {
                pushE({
                    code: 'binding.aggregate_invalid', severity: 'error', path: `${path}.aggregates[${i}].field`,
                    message: `"${a.fn}" needs a field.`,
                    hint: 'Only count can run without one.',
                });
                return;
            }
            if (a.field && a.field !== '*') {
                checkFieldRef(value.tableId, a.field, `${path}.aggregates[${i}].field`, ctx, 'aggregate binding', { codePrefix: 'binding' });
            }
        });
    }
    if (value.kind === 'dataset') {
        checkDatasetRef(value.datasetId, `${path}.datasetId`, ctx, 'dataset binding');
        if (value.params !== undefined && value.params !== null && !isObject(value.params)) {
            pushE({ code: 'binding.params_invalid', severity: 'error', path: `${path}.params`, message: 'dataset params must be an object.', hint: 'Use { paramName: value }.' });
        }
    }
    if (value.kind === 'connector') {
        checkConnectorRef(value.connectorId, `${path}.connectorId`, ctx, 'connector binding');
        if (value.params !== undefined && value.params !== null) validateConnectorParams(value.params, `${path}.params`, ctx);
    }
}

module.exports = {
    validateBinding,
    // The filter grammar, for the filter-mode record writes (stepDataChecks.checkRecordTarget).
    validateBindingFilter,
};

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */
