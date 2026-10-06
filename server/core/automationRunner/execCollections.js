/**
 * Collection operators (Phase B, extracted verbatim from engine.js):
 * filter/limit/dedupe/aggregate/summarize plus the shared arrayRef
 * resolution and "unresolved list" skip stub the list-mode steps build on.
 */

const { evaluate } = require('../../automation/expr');
const { COLLECTION_OP_MAX_ITEMS } = require('./shared');
const { parseTopicExpr, prepareTopics } = require('./topicHost');
const { createRuleMissCounter } = require('./ruleMisses');

// ── Phase B: collection operators ──────────────────────
//
// Each takes step.arrayRef (path string) + per-op config. Resolves to
// an array via bind.walkPath; non-array gets a clear "did not resolve"
// stub instead of crashing the run.

function resolveArrayRef(step, runState, { enforceCap = true } = {}) {
    const v = require('../../automation/bind').walkList(step.arrayRef || '', runState);
    if (!Array.isArray(v)) return null;
    // Input cap (WS5.4): min(step.maxItems, global) — a step can tighten the
    // platform ceiling but never raise it. Throwing (vs truncating) keeps the
    // failure loud and routes through the normal on_error edge handling +
    // error-row recording.
    //
    // `enforceCap:false` exempts Limit (A11): the cap exists to bound
    // per-item CPU (filter's evaluate, dedupe's stringify), but Limit does no
    // per-item work and its output is bounded by `count` — and it IS the
    // escape hatch this error message tells users to add, so capping it made
    // oversized lists permanently un-limitable from the UI.
    const stepMax = (typeof step.maxItems === 'number' && Number.isFinite(step.maxItems) && step.maxItems > 0)
        ? Math.floor(step.maxItems) : null;
    const cap = Math.min(stepMax || COLLECTION_OP_MAX_ITEMS, COLLECTION_OP_MAX_ITEMS);
    if (enforceCap && v.length > cap) {
        const err = new Error(`Collection op input has ${v.length} items (max ${cap}). Add a Limit step upstream to cut the list down first (Limit is exempt from this cap), or raise AUTOMATION_COLLECTION_MAX_ITEMS.`);
        // Stable class for run-history facets, same pattern as
        // automationErrors.js codes — recordRunStep call sites read
        // err.errorClass before falling back to classifyUnknownError.
        err.errorClass = 'collection_too_large';
        throw err;
    }
    return v;
}

/**
 * The one sentence every "I was pointed at a list and did not find one" path
 * shows the user (BFSF-363, BFSF-370).
 *
 * What it replaced said only `arrayRef did not resolve to an array` — true,
 * and useless at the moment it appears: the author is looking at a step that
 * produced nothing and cannot tell WHICH binding broke, what turned up
 * instead, or what to do about it. The report that prompted this describes
 * exactly that loop — "it used to work, now it doesn't, and I don't know why".
 * So name the path, say what was actually there, and name the remedy. The
 * commonest cause by far is an upstream step that has not been re-run, so that
 * is the advice; `skippedReason` (the stable code tests and run-history facets
 * match on) is deliberately untouched by the rewording.
 */
function unresolvedListMessage(label, ref, resolved) {
    const found = resolved === undefined ? 'nothing'
        : resolved === null ? 'null'
        : Array.isArray(resolved) ? 'an array'
            : typeof resolved;
    const where = ref ? `\`${ref}\`` : 'an unset reference';
    return `This step works through a list, but ${label} ${where} did not resolve to one (found ${found}). `
        + 'Re-run the step that produces it, then run this step again — or point this step at a different list.';
}

/**
 * Shared "arrayRef didn't resolve" stub (A10). The top-level `skippedReason`
 * makes runDag's status mapper record the row as `'skipped'` instead of a
 * green `success` — a bound-but-unresolvable source list used to run as a
 * silent empty-result success, indistinguishable from a genuinely empty list.
 * The output keys stay bindable so downstream steps behave exactly as before.
 */
function skippedArrayRef(step, runState, extraOutput) {
    const resolved = require('../../automation/bind').walkPath(step.arrayRef || '', runState);
    return {
        output: { ...extraOutput, skipped: unresolvedListMessage('its source list', step.arrayRef, resolved) },
        skippedReason: 'arrayref_unresolved',
    };
}

async function execFilter(step, ctx, runState) {
    const arr = resolveArrayRef(step, runState);
    if (!arr) return skippedArrayRef(step, runState, { items: [], count: 0 });
    // Compile the expression ONCE, then evaluate the cached AST per item —
    // the string form re-ran tokenize+parse on every element (up to the
    // collection cap of 10k), pure wasted CPU. A malformed expression fails
    // to parse here; surface it as _evalError (matching execCondition /
    // execSwitch) instead of silently dropping every item.
    // Parsed with the topic host spec so an "is about" rule is allowed here;
    // an expression without one parses exactly as parseExpr would.
    let ast;
    try {
        ast = parseTopicExpr(step.expr || 'false');
    } catch (e) {
        return { output: { items: [], count: 0, _evalError: e.message || String(e) } };
    }
    const scope = (i) => ({ ...runState, item: arr[i], _index: i });
    const { host, summary } = await prepareTopics([ast], function* scopes() {
        for (let i = 0; i < arr.length; i++) yield scope(i);
    }, ctx);
    const opts = host ? { host } : undefined;
    const out = [];
    let evalError = null;
    // A rule path that finds nothing on any item goes to the binding log
    // (ruleMisses.js), so a typo is named instead of keeping nothing silently.
    const misses = createRuleMissCounter([{ ast }]);
    for (let i = 0; i < arr.length; i++) {
        let keep = false;
        const itemScope = scope(i);
        try { keep = !!evaluate(ast, itemScope, opts); } catch (e) {
            if (e.topicFatal) throw e;
            keep = false; if (!evalError) evalError = e.message || String(e);
        }
        misses.observe(itemScope);
        if (keep) out.push(arr[i]);
    }
    misses.report(arr.length, null, { matched: out.length });
    // inputCount/rejectedCount: cheap numbers (never the dropped rows) so the
    // canvas can say "3 of 201 kept" on a filter's connection. Additive —
    // absent on rows recorded before this shipped.
    return {
        output: {
            items: out,
            count: out.length,
            inputCount: arr.length,
            rejectedCount: arr.length - out.length,
            ...(summary ? { topics: summary } : {}),
            ...(evalError ? { _evalError: evalError } : {}),
        },
    };
}

async function execLimit(step, ctx, runState) {
    // No cap for Limit (A11): it does no per-item work and its output is
    // bounded by `count` — it is the documented way to shrink oversized lists.
    const arr = resolveArrayRef(step, runState, { enforceCap: false });
    if (!arr) return skippedArrayRef(step, runState, { items: [], count: 0 });
    const n = Math.max(0, Math.floor(Number(step.count) || 0));
    const mode = step.mode === 'last' ? 'last' : 'first';
    // `slice(-0)` is `slice(0)` — a FULL copy: mode=last with count=0 used to
    // return the entire array, the exact opposite of the documented
    // "0 returns no items" (A6).
    const items = n === 0 ? [] : (mode === 'last' ? arr.slice(-n) : arr.slice(0, n));
    return { output: { items, count: items.length } };
}

async function execDedupe(step, ctx, runState) {
    const arr = resolveArrayRef(step, runState);
    if (!arr) return skippedArrayRef(step, runState, { items: [], removed: 0 });
    // keyField sanity pre-scan (A16): when a key is configured but NO item
    // carries it, every item used to key as the string "null" — the whole
    // list silently collapsed to ONE arbitrary item with removed: N-1 and a
    // green status. A typo'd key now passes everything through with a
    // visible warning instead. Partial presence keeps the old behaviour
    // (missing keys group together — defensible for genuinely absent values).
    if (step.keyField && arr.length > 0) {
        const anyHasKey = arr.some(it => it != null && typeof it === 'object' && step.keyField in it);
        if (!anyHasKey) {
            return { output: { items: arr, removed: 0, warning: `keyField "${step.keyField}" not present on any item — deduplication skipped` } };
        }
    }
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const key = step.keyField ? JSON.stringify(item?.[step.keyField] ?? null) : JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return { output: { items: out, removed: arr.length - out.length } };
}

/**
 * Does ANY item carry `field`? (A18 — same probe execDedupe uses for keyField
 * at A16.) A field that is on no item at all is a typo or a renamed source,
 * not "the values happen to be missing": aggregate would emit a list of
 * undefineds and summarize would total nothing and call it 0. Partial presence
 * is a different thing and keeps working, per A16's own precedent.
 */
function anyItemHasField(arr, field) {
    return arr.some(it => it != null && typeof it === 'object' && field in it);
}

async function execAggregate(step, ctx, runState) {
    const arr = resolveArrayRef(step, runState);
    if (!arr) return skippedArrayRef(step, runState, { values: [], count: 0 });
    // A18: a field present on NO item used to produce `values: [undefined × N]`
    // with a green status — a full-length list of nothing, which reads
    // downstream as real data. Record the row as 'skipped' (the A10 /
    // skippedArrayRef mechanism) so it shows amber, while keeping the output
    // keys bindable so downstream steps behave exactly as before.
    if (arr.length > 0 && !anyItemHasField(arr, step.field)) {
        return {
            output: { values: [], count: 0, foundCount: 0, inputCount: arr.length, skipped: `field "${step.field}" is not on any item — nothing to collect` },
            skippedReason: 'aggregate_field_absent',
        };
    }
    const values = arr.map(item => item?.[step.field]);
    // foundCount vs count: how many items actually HAD the field. Partial
    // presence is legitimate, but "40 values, 3 of them real" is worth seeing.
    return { output: { values, count: values.length, foundCount: values.filter(v => v !== undefined).length, inputCount: arr.length } };
}

async function execSummarize(step, ctx, runState) {
    const arr = resolveArrayRef(step, runState);
    if (!arr) return skippedArrayRef(step, runState, { result: null, op: step.op, count: 0 });
    // A18: `Number(undefined)` is NaN, which the filter below drops — so a
    // mistyped or renamed field made `sum`/`avg` return 0 and the run record a
    // green success. An automation that totals invoice amounts reported €0 and the
    // notification said so. `count` is exempt: it counts ITEMS and never reads
    // the field (A7).
    if (step.op !== 'count' && arr.length > 0 && !anyItemHasField(arr, step.field)) {
        return {
            output: { result: null, op: step.op, count: 0, usedCount: 0, inputCount: arr.length, skipped: `field "${step.field}" is not on any item — nothing to ${step.op}` },
            skippedReason: 'summarize_field_absent',
        };
    }
    const values = arr.map(item => Number(item?.[step.field])).filter(v => Number.isFinite(v));
    let result = null;
    switch (step.op) {
        case 'count': result = arr.length; break;
        case 'sum':   result = values.reduce((a, b) => a + b, 0); break;
        case 'avg':   result = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; break;
        case 'min':   result = values.length ? Math.min(...values) : null; break;
        case 'max':   result = values.length ? Math.max(...values) : null; break;
        // Validator-blocked (validate.js summarize.op_invalid), but hand-written
        // and AI-authored definitions still reach it — fail loud rather than
        // record a success with a null result (A17, as execDateTime does).
        default: {
            const err = new Error(`Unknown summarize op: ${step.op}`);
            err.errorClass = 'summarize_op_unknown';
            throw err;
        }
    }
    // op='count' counts ITEMS (field is ignored), so `count` must report the
    // item count too — it used to report values.length, which is 0 for
    // non-numeric items while `result` showed the true length (A7).
    // usedCount/inputCount say how much of the list the number is built from:
    // "12 of 40 items had that field" is the difference between a total and a
    // misleading total.
    return {
        output: {
            result,
            op: step.op,
            count: step.op === 'count' ? arr.length : values.length,
            usedCount: values.length,
            inputCount: arr.length,
        },
    };
}

module.exports = {
    resolveArrayRef, unresolvedListMessage, skippedArrayRef,
    execFilter, execLimit, execDedupe, execAggregate, execSummarize,
};
