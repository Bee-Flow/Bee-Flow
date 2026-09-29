/**
 * App Studio canonicalizer — the binding grammar: formulas, the record /
 * records / aggregate query descriptors, dataset and connector params, and the
 * wrapping of bare values as { kind: 'static' }.
 */

'use strict';

const { LIMITS } = require('../componentSpecs');
const { isObject, deepCopy, truncate, isFormulaObj } = require('./shared');

// ---------------------------------------------------------------------------
// Bindings — wrap bare values as static, infer actionResult from actionId.
// ---------------------------------------------------------------------------

// A formula binding/field: { kind:'formula', expr }. Only the length limit is
// enforced here — the shared expr compiler runs in validate.js (never here, and
// the expression is NEVER executed).
function cleanFormula(raw, path, push) {
    let expr = raw.expr;
    if (typeof expr === 'string') expr = truncate(expr, LIMITS.MAX_FORMULA_LEN, path, push);
    else expr = deepCopy(expr);   // wrong type left for validate.js
    return { kind: 'formula', expr };
}

// Shared filter/sort/limit copy for record + records bindings.
function copyRecordsQuery(raw, out, path, push) {
    if (raw.filter !== undefined && raw.filter !== null) {
        out.filter = typeof raw.filter === 'string' ? truncate(raw.filter, LIMITS.MAX_FORMULA_LEN, `${path}.filter`, push) : deepCopy(raw.filter);
    }
    if (raw.sort !== undefined && raw.sort !== null) out.sort = deepCopy(raw.sort);
    if (raw.limit !== undefined && raw.limit !== null) {
        out.limit = (typeof raw.limit === 'string' && raw.limit.trim() !== '' && Number.isFinite(Number(raw.limit))) ? Number(raw.limit) : deepCopy(raw.limit);
    }
}

// Connector binding params — { key: literal | {kind:'formula',expr} }. Known
// formula params rebuilt to their exact shape (expr truncated); literals kept
// verbatim; malformed objects passed through for validate.js to flag.
function cleanConnectorParams(raw, path, push) {
    if (!isObject(raw)) {
        push('binding.params_invalid', path, 'connector params must be an object map — reset to {}.');
        return {};
    }
    const out = {};
    for (const [key, v] of Object.entries(raw)) {
        const p = `${path}.${key}`;
        if (isObject(v) && v.kind === 'formula') out[key] = cleanFormula(v, `${p}.expr`, push);
        else out[key] = deepCopy(v);
    }
    return out;
}

/**
 * `pick: { row, column }` narrows a row-shaped result to ONE value — what a stat
 * tile means by "the number". Purely a read-side lens (the runtime's applyPick),
 * so it is preserved rather than interpreted here; dropping it would silently
 * turn a configured tile back into a raw row dump on the next save.
 */
function cleanPick(raw, out) {
    if (!isObject(raw.pick)) return;
    const pick = {};
    if (raw.pick.row === 'last' || raw.pick.row === 'first') pick.row = raw.pick.row;
    if (typeof raw.pick.column === 'string' && raw.pick.column) pick.column = raw.pick.column;
    if (Object.keys(pick).length) out.pick = pick;
}

// Caps mirror the compiler's MAX_GROUP_BY / MAX_AGGREGATES so a definition can
// never carry a descriptor the server would refuse at query time.
const MAX_AGG_GROUP_BY = 8;
const MAX_AGG_FNS = 16;

/**
 * Clean an aggregate's groupBy list. Entries whose bucket the compiler does not
 * know are dropped rather than kept: a stored descriptor that always throws at
 * query time is worse than a slightly different chart.
 */
function cleanAggGroupBy(raw, path, push) {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
        push('binding.aggregate_invalid', `${path}.groupBy`, 'groupBy must be an array — dropped.');
        return undefined;
    }
    const { DATE_BUCKETS } = require('../dataModel');
    const out = [];
    for (const g of raw.slice(0, MAX_AGG_GROUP_BY)) {
        if (!isObject(g) || typeof g.field !== 'string' || !g.field) continue;
        const entry = { field: g.field };
        if (typeof g.bucket === 'string') {
            if (DATE_BUCKETS.includes(g.bucket)) entry.bucket = g.bucket;
            else push('binding.aggregate_invalid', `${path}.groupBy`, `Unknown date bucket "${g.bucket}" — dropped.`);
        }
        if (typeof g.as === 'string' && g.as) entry.as = g.as;
        out.push(entry);
    }
    return out.length ? out : undefined;
}

function cleanAggregates(raw, path, push) {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
        push('binding.aggregate_invalid', `${path}.aggregates`, 'aggregates must be an array — dropped.');
        return undefined;
    }
    const { AGG_FNS } = require('../dataModel');
    const out = [];
    for (const a of raw.slice(0, MAX_AGG_FNS)) {
        if (!isObject(a) || typeof a.fn !== 'string') continue;
        if (!AGG_FNS.includes(a.fn)) {
            push('binding.aggregate_invalid', `${path}.aggregates`, `Unknown aggregate "${a.fn}" — dropped.`);
            continue;
        }
        const entry = { fn: a.fn };
        if (typeof a.field === 'string' && a.field) entry.field = a.field;
        if (typeof a.as === 'string' && a.as) entry.as = a.as;
        out.push(entry);
    }
    return out.length ? out : undefined;
}

function cleanBinding(raw, path, push) {
    if (isObject(raw)) {
        if (raw.kind === 'static') return { kind: 'static', value: deepCopy(raw.value) ?? null };
        if (raw.kind === 'actionResult') {
            const out = { kind: 'actionResult', actionId: raw.actionId };
            if (raw.path !== undefined && raw.path !== null) out.path = raw.path;
            return out;
        }
        if (raw.kind === 'formula') return cleanFormula(raw, `${path}.expr`, push);
        if (raw.kind === 'record') {
            // record carries the same filter/sort/limit grammar as records
            // ("first matching row") — dropping them here would silently strip
            // AI-authored filters before validate.js ever sees them.
            const out = { kind: 'record', tableId: raw.tableId };
            if (raw.path !== undefined && raw.path !== null) out.path = raw.path;
            copyRecordsQuery(raw, out, path, push);
            cleanPick(raw, out);
            // `recordId` is documented, accepted by the validator — and read by
            // NOTHING. A binding that named one therefore fetched the table's
            // first row and rendered it as though it were the record asked for:
            // a detail header showing a different customer than the one you
            // opened, with no error anywhere. It has always MEANT `id == this`,
            // so that is what it becomes here, in the one grammar both the
            // browser and stepDataSource already honour. Prepended, so an
            // author's own filters still narrow it further.
            if (raw.recordId !== undefined && raw.recordId !== null) {
                const idFilter = { field: 'id', op: 'eq', value: deepCopy(raw.recordId) };
                out.filter = Array.isArray(out.filter) ? [idFilter, ...out.filter] : [idFilter];
                push('binding.record_id_to_filter', path,
                    'record binding: folded `recordId` into filter id == <value> (nothing reads recordId).');
            }
            return out;
        }
        if (raw.kind === 'records') {
            const out = { kind: 'records', tableId: raw.tableId };
            copyRecordsQuery(raw, out, path, push);
            cleanPick(raw, out);
            return out;
        }
        if (raw.kind === 'aggregate') {
            const out = { kind: 'aggregate', tableId: raw.tableId };
            copyRecordsQuery(raw, out, path, push);
            // groupBy/aggregates may each be a FORMULA instead of a literal
            // list: that is what lets a saved report row supply the question at
            // runtime (see resolveBindingShape in the runtime). The formula is
            // parse-checked here and evaluated client-side before the fetch;
            // the server re-validates the resolved descriptor against the real
            // table either way, so a dynamic descriptor can reach no further
            // than a hand-authored one.
            if (isFormulaObj(raw.groupBy)) out.groupBy = cleanFormula(raw.groupBy, `${path}.groupBy.expr`, push);
            else {
                const groupBy = cleanAggGroupBy(raw.groupBy, path, push);
                if (groupBy) out.groupBy = groupBy;
            }
            if (isFormulaObj(raw.aggregates)) out.aggregates = cleanFormula(raw.aggregates, `${path}.aggregates.expr`, push);
            else {
                const aggregates = cleanAggregates(raw.aggregates, path, push);
                if (aggregates) out.aggregates = aggregates;
            }
            cleanPick(raw, out);
            return out;
        }
        if (raw.kind === 'dataset') {
            const out = { kind: 'dataset', datasetId: raw.datasetId };
            if (raw.params !== undefined && raw.params !== null) out.params = deepCopy(raw.params);
            cleanPick(raw, out);
            return out;
        }
        if (raw.kind === 'connector') {
            // params is a map { key: literal | {kind:'formula',expr} }. Formula
            // params are rebuilt to their exact shape (expr truncated); literals
            // pass through — the runtime resolves formulas client-side, then the
            // server re-sanitises before the connector runs acts-as-owner.
            const out = { kind: 'connector', connectorId: raw.connectorId };
            if (raw.params !== undefined && raw.params !== null) out.params = cleanConnectorParams(raw.params, `${path}.params`, push);
            return out;
        }
        if (!('kind' in raw) && typeof raw.actionId === 'string') {
            push('binding.wrapped', path, 'Binding object had an actionId but no kind — set kind:"actionResult".');
            const out = { kind: 'actionResult', actionId: raw.actionId };
            if (raw.path !== undefined && raw.path !== null) out.path = raw.path;
            return out;
        }
        if (!('kind' in raw) && 'value' in raw && Object.keys(raw).every((k) => k === 'value')) {
            push('binding.wrapped', path, 'Wrapped { value: … } as { kind: "static", value: … }.');
            return { kind: 'static', value: deepCopy(raw.value) ?? null };
        }
        // Unrecognised kind string — leave for the validator to flag precisely.
        if (typeof raw.kind === 'string') return deepCopy(raw);
        // Plain data object where a binding was expected — treat as a literal.
        push('binding.wrapped', path, 'Wrapped bare object as { kind: "static", value: … }.');
        return { kind: 'static', value: deepCopy(raw) };
    }
    push('binding.wrapped', path, `Wrapped bare value ${JSON.stringify(raw)} as { kind: "static", value: … }.`);
    const copied = deepCopy(raw);
    return { kind: 'static', value: copied === undefined ? null : copied };
}

module.exports = {
    cleanFormula,
    copyRecordsQuery,
    cleanConnectorParams,
    cleanPick,
    cleanAggGroupBy,
    cleanAggregates,
    cleanBinding,
};
