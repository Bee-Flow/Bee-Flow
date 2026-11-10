// @typecheck strict
/**
 * The formula vocabulary of the builder catalog, DERIVED from the shared
 * expression engine (split out of catalogRender.js).
 *
 * The enumeration walks EXPR_FUNCTION_NAMES — FUNCTIONS plus the list forms,
 * i.e. the exact set the parser accepts at PARSE time — so it cannot drift from
 * the engine the way a hand-maintained list does. It did drift, expensively: the
 * whole maths family (pow/sqrt/ln/log/exp/trig, PI(), E(), the `^` operator)
 * existed with nothing anywhere in the prompt naming any of it, and the builder
 * told a user their scientific calculator was unbuildable. Signatures come from
 * the EXPR_FUNCTIONS doc table; a name that table has not caught up with still
 * renders as `name(…)` rather than vanishing from the prompt.
 *
 * The compact catalog (small models, core prompt) keeps the vocabulary it had
 * before the list functions and the regex pair arrived: its budget only goes
 * down (catalogRender.test.js). Those names still parse there; the full catalog
 * and the MCP guide teach them.
 *
 * Wrapping is a fixed-width greedy fill over a fixed input — deterministic, so
 * the catalog stays byte-stable (prompt-cache discipline).
 */

'use strict';

const { EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } = require('../../shared/expr/index.mjs');

const FORMULA_WRAP_COLS = 108;

/** Names the compact catalog leaves out (see the header). */
const NOT_IN_COMPACT = new Set(['unique', 'regexMatch', 'regexReplace', 'map', 'filter', 'some', 'every']);

/**
 * Functions that arrived with schema version 3 (`since: 3` on their doc entry:
 * sort, reverse, slice, groupBy, keys, values, merge, range, reduce). The
 * catalog text is byte-pinned, so neither rendering prints them; they are
 * served on demand.
 */
const SINCE_3 = new Set(EXPR_FUNCTIONS.filter((f) => /** @type {{ since?: number }} */ (f).since !== undefined).map((f) => f.name));

/** Signatures the compact catalog keeps in their earlier, shorter form. */
const COMPACT_SIGNATURES = new Map([['sum', 'sum(list)']]);

/** The full catalog's sentence on member access, `it` and the regex subset (after "no method calls on values."). */
const LIST_FORMS_TEXT = ' A call result reads on like a path: find(rows, "id", x).name, first(list).y, (a || b).name. map/filter/some/every(list, expr) read each item as it: filter(rows, it.status == "open"). regexMatch/regexReplace: pattern and flags (i, m, s) are quoted literals; no look-around or back-references, no repeat or | inside a repeated group ((a+)+, (a|b)+: write [ab]+); write [0-9], not \\d.';

/** The full catalog's sentence on OR groups (after the filter line). */
const ANY_GROUP_TEXT = ' OR: an entry {"any":[<entries>]} matches when ONE of them does and ANDs with the rest (one level; max 50 clauses in all).';

/**
 * The callable names a formula may use, wrapped.
 * @param {{ compact?: boolean }} [opts]
 */
function renderFormulaFunctions(opts = {}) {
    const signatureByName = new Map(EXPR_FUNCTIONS.map((f) => [f.name, f.signature]));
    /** @type {string[]} */
    const lines = [];
    let line = '';
    for (const name of EXPR_FUNCTION_NAMES) {
        if (SINCE_3.has(name)) continue;
        if (opts.compact && NOT_IN_COMPACT.has(name)) continue;
        const sig = (opts.compact && COMPACT_SIGNATURES.get(name)) || signatureByName.get(name) || `${name}(…)`;
        const next = line ? `${line}, ${sig}` : sig;
        if (line && next.length > FORMULA_WRAP_COLS) {
            lines.push(`${line},`);
            line = sig;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines.join('\n');
}

module.exports = { renderFormulaFunctions, LIST_FORMS_TEXT, ANY_GROUP_TEXT, NOT_IN_COMPACT, COMPACT_SIGNATURES, SINCE_3 };
